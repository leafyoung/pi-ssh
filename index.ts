import { constants, mkdirSync, readFileSync } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SessionManager, type ExtensionAPI, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

interface SshConnection {
  remote: string;
  /** Explicit port from --ssh-port; null = honor ~/.ssh config / ssh default. */
  port: number | null;
  remoteCwd: string;
  remoteHome: string;
  localCwd: string;
  localHome: string;
  /**
   * How to give payloads their own process group for reliable aborts:
   * "setsid" (util-linux), "perl" (POSIX::setsid fallback, e.g. macOS),
   * or "single" (no group support - abort degrades to killing the wrapper
   * bash only; children finish naturally, never hangs).
   */
  abortMode: "setsid" | "perl" | "single";
  /** "windows" remotes run one-shot cmd/PowerShell execs instead of a persistent shell. */
  platform: "posix" | "windows";
}

interface SshCaptureOptions {
  stdin?: string | Buffer;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

interface RunningCommand {
  startMarker: string;
  endMarker: string;
  pidFile: string;
  timeout?: number;
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  aborted: boolean;
  timedOut: boolean;
  timeoutHandle?: NodeJS.Timeout;
  injectHandle?: NodeJS.Timeout;
  abortHandler?: () => void;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  resolve: (value: { exitCode: number | null }) => void;
  reject: (error: Error) => void;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDelimitedShellOutput(
  stdoutText: string,
  startMarker: string,
  endMarker: string,
): { output: string; exitCode: number | null } | null {
  // Normalize BOTH \r\n and bare \r (PR #9): some PTYs emit bare carriage
  // returns around prompt/control sequences, which would otherwise hide the
  // completion marker and hang the command forever.
  const text = stdoutText.replace(/\r\n?/g, "\n");

  // Markers are searched anywhere in the stream, NOT anchored to line start.
  // Remote shell integrations (e.g. Ghostty OSC 3008, iTerm2 OSC 133) emit
  // escape sequences right before command output, which can glue the start
  // marker mid-line after an ESC-\ terminator; line anchoring would then
  // never match and the command would hang forever. The markers embed a
  // timestamp + random hex id, so false positives inside command output are
  // practically impossible.
  const endRegex = new RegExp(`${escapeRegex(endMarker)}:(-?\\d+)(?=\\n|$)`);
  const endMatch = endRegex.exec(text);
  if (!endMatch) {
    return null;
  }

  const endLineStart = endMatch.index;

  const startRegex = new RegExp(`${escapeRegex(startMarker)}(?=\\n|$)`, "g");
  let startLineEnd = 0;
  let foundStart = false;
  while (true) {
    const startMatch = startRegex.exec(text);
    if (!startMatch) break;

    const startLineStart = startMatch.index;
    if (startLineStart >= endLineStart) break;

    foundStart = true;
    startLineEnd = startLineStart + startMarker.length;
    if (text[startLineEnd] === "\n") {
      startLineEnd += 1;
    }
  }

  if (!foundStart) {
    return null;
  }

  const output = text.slice(startLineEnd, endLineStart);
  const parsedExitCode = Number(endMatch[1]);
  const exitCode = Number.isNaN(parsedExitCode) ? null : parsedExitCode;
  return { output, exitCode };
}

class CommandQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// Lookahead boundary so we replace `/local/cwd` and `/local/cwd/sub`, but not
// `/local/cwd-backup` (a different directory that merely shares the prefix).
const LOCAL_PATH_END_LOOKAHEAD = "(?=$|[\\s'\"`\\\\;:)&|<>\\],}]|/)";

/**
 * Rewrite local absolute paths embedded INSIDE a command string to their remote
 * equivalents. The tool layer only maps the bash tool's `cwd` argument; anything
 * the model typed into the command itself (e.g. `ls -la /Users/me/project`) would
 * otherwise reach the remote shell verbatim and fail with ENOENT.
 */
function mapLocalPathsInCommand(command: string, conn: SshConnection): string {
  // Most specific prefix first: localCwd is usually nested under localHome.
  const mappings: Array<[string, string]> = [];
  if (conn.localCwd !== conn.remoteCwd) mappings.push([conn.localCwd, conn.remoteCwd]);
  if (conn.localHome !== conn.remoteHome) mappings.push([conn.localHome, conn.remoteHome]);
  mappings.sort((a, b) => b[0].length - a[0].length);

  let result = command;
  for (const [from, to] of mappings) {
    // Function replacement so `$` in remote paths is not treated as a pattern.
    result = result.replace(new RegExp(escapeRegex(from) + LOCAL_PATH_END_LOOKAHEAD, "g"), () => to);
  }
  return result;
}

function isLocalTempFilePath(path: string): boolean {
  return path === tmpdir() || path.startsWith(`${tmpdir()}/`);
}

/**
 * pi/skills configuration paths are NEVER mapped to the remote host: the
 * system prompt advertises the LOCAL skill/config content, so reads resolve
 * locally (justcyl's "keep pi config paths local"). Shell commands are
 * deliberately not protected - the execution view stays remote.
 */
function isProtectedLocalPath(absolutePath: string): boolean {
  const home = homedir();
  const dirs = [join(home, ".pi"), join(home, ".config", "pi"), join(home, ".agents")];
  return dirs.some((dir) => absolutePath === dir || absolutePath.startsWith(`${dir}/`));
}

function mapLocalPathToRemote(path: string, conn: SshConnection): string {
  if (path === conn.localCwd) return conn.remoteCwd;
  if (path.startsWith(`${conn.localCwd}/`)) {
    return `${conn.remoteCwd}${path.slice(conn.localCwd.length)}`;
  }
  if (path === conn.localHome) return conn.remoteHome;
  if (path.startsWith(`${conn.localHome}/`)) {
    return `${conn.remoteHome}${path.slice(conn.localHome.length)}`;
  }
  return path;
}

function findRemotePathSeparator(value: string): number {
  const colonIndex = value.lastIndexOf(":");
  if (colonIndex === -1) {
    return -1;
  }

  const remotePath = value.slice(colonIndex + 1).trim();
  if (remotePath.startsWith("/") || remotePath === "~" || remotePath.startsWith("~/")) {
    return colonIndex;
  }

  // Preserve host:relative-path for the common single-colon form, but avoid
  // mis-parsing IPv6 literals without an explicit remote path.
  if (value.indexOf(":") === colonIndex) {
    return colonIndex;
  }

  return -1;
}

/**
 * Windows-aware scan (furkan-bilgin): `user@host:C:\Users\me` has two colons
 * (host separator + drive letter) - lastIndexOf would pick the drive colon.
 * Scan left-to-right and skip drive-letter pseudo-splits.
 */
function findWindowsAwarePathSeparator(value: string): number {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== ":") continue;
    const before = value.slice(0, i).trim();
    const remotePath = value.slice(i + 1).trim();
    // Drive letter with separator or drive-relative: not the host separator.
    if (before.length === 1 && /^[A-Za-z]$/.test(before)) continue;
    if (/^[A-Za-z]:/.test(remotePath) && before.includes("@") === false && before.length > 0 && value.indexOf(":", i + 1) !== -1) {
      // A later colon may still be the real separator; keep scanning.
      continue;
    }
    if (
      remotePath.startsWith("/") ||
      remotePath.startsWith("\\") ||
      remotePath === "~" ||
      remotePath.startsWith("~/") ||
      /^[A-Za-z]:[\\/]/.test(remotePath)
    ) {
      return i;
    }
  }
  return findRemotePathSeparator(value);
}

export function parseSshFlag(raw: string): { remote: string; remotePath?: string } {
  const value = raw.trim();
  if (!value) {
    throw new Error("--ssh requires a value like user@host or user@host:/remote/path");
  }

  const colonIndex = findWindowsAwarePathSeparator(value);
  if (colonIndex === -1) {
    return { remote: value };
  }

  const remote = value.slice(0, colonIndex).trim();
  const remotePath = value.slice(colonIndex + 1).trim();
  if (!remote) {
    throw new Error("Invalid --ssh value: missing remote host");
  }
  if (!remotePath) {
    throw new Error("Invalid --ssh value: empty remote path");
  }
  return { remote, remotePath };
}

function parseSshPort(raw: string | undefined): number {
  const value = (raw ?? "22").trim();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid SSH port: ${value}`);
  }
  return parsed;
}

// Per-user, 0700 control-socket directory: /tmp control paths are predictable
// and world-writable, letting any local user pre-place a socket (pansapiens).
const CONTROL_SOCKET_DIR = join(homedir(), ".cache", "pi-ssh");
try {
  mkdirSync(CONTROL_SOCKET_DIR, { recursive: true, mode: 0o700 });
} catch {
  /* best effort - ssh reports a usable-path error itself */
}

function buildSshBaseArgs(port: number | null): string[] {
  const args: string[] = [];
  // null = let ~/.ssh/config / the ssh default decide (IA386, justcyl):
  // forcing -p 22 overrides a configured "Port 2222".
  if (port !== null) {
    args.push("-p", String(port));
  }
  args.push(
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=600",
    "-o",
    `ControlPath=${join(CONTROL_SOCKET_DIR, "cm-%C")}`,
    // Keep the master alive through NAT/firewall idle timeouts and detect dead
    // peers instead of hanging tool calls on a silently dropped connection.
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    // Coding workloads are text-heavy; compression cuts transfer size several
    // fold on slow links for negligible CPU. Only applies to the master.
    "-o",
    "Compression=yes",
    // pansapiens: accept new host keys automatically (TOFU) but refuse changed
    // keys (MITM); BatchMode prevents a piped, non-interactive password prompt
    // from hanging tool calls.
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
  );
  return args;
}

function looksLikeWindowsPath(remotePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(remotePath) || remotePath.startsWith("\\");
}

function buildResolveRemotePathCommand(remotePath: string): string {
  // Windows remote (cmd.exe): cd /d switches drives too. POSIX form first so
  // the combined probe works before the platform is known.
  if (looksLikeWindowsPath(remotePath)) {
    return `cd /d "${remotePath.replace(/\//g, "\\")}" && cd`;
  }
  if (remotePath === "~") {
    return 'cd -- "$HOME" && pwd';
  }
  if (remotePath.startsWith("~/")) {
    return `cd -- "$HOME"/${shellQuote(remotePath.slice(2))} && pwd`;
  }
  return `(cd -- ${shellQuote(remotePath)} 2>/dev/null && pwd) || (cd /d "${remotePath}" && cd)`;
}

async function sshCapture(
  remote: string,
  port: number | null,
  remoteCommand: string,
  options: SshCaptureOptions = {},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...buildSshBaseArgs(port), remote, remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timeoutHandle =
      options.timeoutSeconds && options.timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutSeconds * 1000)
        : undefined;

    const onAbort = () => child.kill();
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("close", (exitCode) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode,
        timedOut,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function sshExec(remote: string, port: number | null, remoteCommand: string, options: SshCaptureOptions = {}): Promise<Buffer> {
  const result = await sshCapture(remote, port, remoteCommand, options);
  if (result.timedOut) {
    throw new Error(`SSH command timed out after ${options.timeoutSeconds ?? 0}s`);
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf-8").trim();
    const message = stderr || `SSH command failed with exit code ${result.exitCode}`;
    throw new Error(message);
  }
  return result.stdout;
}

// ---- Windows remote support (furkan-bilgin) ----
// Windows OpenSSH always lands in cmd.exe interactively; there is no reliable
// persistent shell. All Windows operations run as one-shot ssh execs whose
// payload is a PowerShell -EncodedCommand (pure base64, cmd-safe). Aborts use
// taskkill /F /T on a recorded PID (Windows orphans remote processes when the
// local ssh client disconnects, so an active kill is required).

function powershellEncoded(script: string): string {
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsPidFile(unique: string): string {
  return `%TEMP%\\pi-ssh-pid-${unique}.txt`;
}

// Default timeout (5 minutes) prevents a single hung command from blocking
// the entire SSH command queue forever.
const DEFAULT_EXEC_TIMEOUT_SECONDS = 300;

// Payloads are inlined into the remote wrapper as base64 (bash -c argv).
// Linux caps a single argv string at 128KB (MAX_ARG_STRLEN); stay well below.
const INLINE_PAYLOAD_MAX_BYTES = 60 * 1024;

class PersistentRemoteShell {
  private connection: SshConnection;
  private child: ChildProcessWithoutNullStreams | null = null;
  private running: RunningCommand | null = null;
  private disposed = false;
  // Incremental streaming state: tracks how many bytes of the normalized
  // (post-start-marker) output have already been sent via onData.
  private streamedBytes = 0;
  private seenStartMarker = false;
  // Position in the raw stdout text right after the start marker line.
  private startMarkerEnd = 0;
  // Readiness handshake (IA386): resolved once the remote shell has proven it
  // processes input, so the first real command can't race shell startup.
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyBuffer = "";

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.readyResolve) {
      this.readyReject?.(new Error("Remote shell disposed"));
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (this.running) {
      this.running.reject(new Error("Remote shell disposed"));
      this.running = null;
    }
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }

  exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }): Promise<{ exitCode: number | null }> {
    return this.execOne(command, cwd, options);
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("Remote shell is disposed");
    }
    if (this.connection.platform === "windows") {
      throw new Error("No persistent shell on Windows remotes; use one-shot exec");
    }
    if (this.child && !this.child.killed) {
      return;
    }

    const child = spawn("ssh", [...buildSshBaseArgs(this.connection.port), "-tt", this.connection.remote], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("error", (error) => {
      if (this.running) {
        this.running.reject(error instanceof Error ? error : new Error(String(error)));
        this.cleanupRunning();
      }
    });

    child.on("close", () => {
      if (this.readyResolve) {
        this.readyReject?.(new Error("SSH shell closed during startup"));
        this.readyResolve = null;
        this.readyReject = null;
      }
      if (this.running) {
        this.running.reject(new Error("SSH shell closed unexpectedly"));
        this.cleanupRunning();
      }
      this.child = null;
    });

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));

    this.child = child;
    this.child.stdin.write(
      "stty -echo 2>/dev/null || true; unset PROMPT_COMMAND 2>/dev/null || true; PS1=''; PS2=''; PROMPT=''; RPROMPT=''; " +
        "export PAGER=cat; export GIT_PAGER=cat; export GIT_TERMINAL_PROMPT=0; export HISTFILE=/dev/null; " +
        // Stray SIGINT must never kill the interactive shell itself. bash
        // resets an inherited ignored-INT disposition for its children, so
        // payload trees stay INT-killable despite this trap (verified live).
        "trap '' INT 2>/dev/null || true; " +
        "if [ -n \"${ZSH_VERSION-}\" ]; then precmd_functions=(); preexec_functions=(); chpwd_functions=(); unset zle_bracketed_paste 2>/dev/null || true; fi; " +
        "if [ -n \"${BASH_VERSION-}\" ]; then bind 'set enable-bracketed-paste off' 2>/dev/null || true; fi\n",
    );
    this.child.stdin.write(`cd -- ${shellQuote(this.connection.remoteCwd)}\n`);

    // Readiness handshake: don't hand execOne a shell until the remote side has
    // provably processed input. Otherwise the first command can interleave with
    // motd / shell-integration output or get lost during shell startup.
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.child.stdin.write("printf '\\n__PI_SSH_READY__\\n'\n");
  }

  private readyPromise: Promise<void> | null = null;

  private handleStdout(chunk: Buffer): void {
    // Readiness handshake completes on the first sign of life from the shell.
    if (this.readyResolve) {
      this.readyBuffer += chunk.toString("utf-8");
      if (this.readyBuffer.includes("__PI_SSH_READY__")) {
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        this.readyBuffer = "";
        resolve();
      }
    }
    const running = this.running;
    if (!running) return;
    running.stdoutChunks.push(chunk);
    this.streamIncremental();
    this.tryCompleteRunning();
  }

  private handleStderr(chunk: Buffer): void {
    const running = this.running;
    if (!running) return;
    running.stderrChunks.push(chunk);
  }

  /**
   * Normalize raw PTY output the same way parseDelimitedShellOutput does:
   * replace \r\n and bare \r (PR #9) with \n. Base64 payloads are unaffected
   * (the alphabet excludes \r), so byte-exact reads survive this.
   */
  private normalize(text: string): string {
    return text.replace(/\r\n?/g, "\n");
  }

  /**
   * Stream output incrementally to onData as it arrives, rather than
   * waiting for the command to complete. This enables live progress
   * in the TUI (tool_execution_update events).
   *
   * Works on normalized text so the bytes sent match parseDelimitedShellOutput
   * output exactly, allowing correct "remaining" calculation at completion.
   */
  private streamIncremental(): void {
    const running = this.running;
    if (!running) return;

    const rawText = Buffer.concat(running.stdoutChunks).toString("utf-8");
    const text = this.normalize(rawText);

    // Wait until we've seen the start marker before streaming anything.
    // Unanchored: shell-integration escape sequences (Ghostty OSC 3008 etc.)
    // can glue the marker mid-line — see parseDelimitedShellOutput.
    if (!this.seenStartMarker) {
      const startRegex = new RegExp(`${escapeRegex(running.startMarker)}\\n`);
      const startMatch = startRegex.exec(text);
      if (!startMatch) return;
      this.seenStartMarker = true;
      this.startMarkerEnd = startMatch.index + startMatch[0].length;
      this.streamedBytes = 0;
    }

    // Extract the output region: everything after the start marker
    const outputSoFar = text.slice(this.startMarkerEnd);

    // Hold back the last 1-2 lines to avoid streaming partial end markers.
    // The end marker looks like: __PI_SSH_DONE_<id>__:<exitcode>
    // Find the last newline that's safe to stream up to.
    const endMarkerPrefix = "__PI_SSH_DONE_";
    let safeLen = outputSoFar.length;

    // Walk back from the end to find lines that might be (partial) end markers
    const lastNl = outputSoFar.lastIndexOf("\n");
    if (lastNl >= 0) {
      const tailLine = outputSoFar.slice(lastNl + 1);
      if (tailLine.length === 0 || tailLine.includes(endMarkerPrefix) || endMarkerPrefix.startsWith(tailLine.trimEnd())) {
        // The incomplete last line might be a marker; hold it back
        safeLen = lastNl + 1;
      }
      // Also check the last complete line
      if (safeLen === lastNl + 1) {
        const prevNl = outputSoFar.lastIndexOf("\n", lastNl - 1);
        const lastCompleteLine = outputSoFar.slice(prevNl + 1, lastNl);
        if (lastCompleteLine.includes(endMarkerPrefix)) {
          safeLen = Math.max(0, prevNl + 1);
        }
      }
    } else {
      // No newline at all yet — could be a partial marker, hold everything back
      if (outputSoFar.includes(endMarkerPrefix) || endMarkerPrefix.startsWith(outputSoFar.trimEnd())) {
        safeLen = 0;
      }
    }

    if (safeLen > this.streamedBytes) {
      const newData = outputSoFar.slice(this.streamedBytes, safeLen);
      if (newData.length > 0) {
        running.onData(Buffer.from(newData, "utf-8"));
        this.streamedBytes = safeLen;
      }
    }
  }

  private tryCompleteRunning(): void {
    const running = this.running;
    if (!running) return;

    const rawText = Buffer.concat(running.stdoutChunks).toString("utf-8");
    const parsed = parseDelimitedShellOutput(rawText, running.startMarker, running.endMarker);
    if (!parsed) return;

    // parsed.output is the normalized output between markers.
    // Send any bytes we haven't streamed yet (the held-back tail).
    const fullOutput = parsed.output;
    if (this.streamedBytes < fullOutput.length) {
      const remaining = fullOutput.slice(this.streamedBytes);
      running.onData(Buffer.from(remaining, "utf-8"));
    }

    // Also send stderr (merged at the end, matching original behavior)
    const stderr = Buffer.concat(running.stderrChunks);
    if (stderr.length > 0) {
      running.onData(stderr);
    }

    const exitCode = parsed.exitCode;
    const timedOut = running.timedOut;
    const aborted = running.aborted;
    const timeout = running.timeout;

    this.cleanupRunning();

    if (timedOut) {
      running.reject(new Error(`timeout:${timeout}`));
      return;
    }
    if (aborted) {
      running.reject(new Error("aborted"));
      return;
    }

    running.resolve({ exitCode });
  }

  private cleanupRunning(): void {
    if (!this.running) return;
    if (this.running.timeoutHandle) clearTimeout(this.running.timeoutHandle);
    if (this.running.injectHandle) clearTimeout(this.running.injectHandle);
    if (this.running.signal && this.running.abortHandler) {
      this.running.signal.removeEventListener("abort", this.running.abortHandler);
    }
    this.running = null;
  }

  private abortCurrentCommand(): void {
    const running = this.running;
    if (!running) return;

    // Primary: kill the payload's process group over a one-shot SSH. Each
    // payload runs under `setsid` with its leader PID recorded to a file, so
    // this reaches the whole tree. (No Ctrl-C: interactive line editors like
    // zsh's ZLE own the TTY in raw mode, swallow \x03, and even when a SIGINT
    // lands, interactive shells abandon the REST OF THE INPUT LINE - so the
    // `printf END:<id>` following the command never executes and the queue
    // would hang forever. External kills don't trigger the line-abandon.)
    if (running.pidFile) {
      const qpid = shellQuote(running.pidFile);
      // TERM, not INT: the shell traps '' INT (stray-TTY protection) and an
      // ignored INT disposition is inherited by payloads, which would make a
      // group INT a no-op. TERM disposition is untouched by the trap.
      const killCommand =
        this.connection.abortMode === "single"
          ? `kill -TERM "$(cat ${qpid} 2>/dev/null)" 2>/dev/null; rm -f ${qpid}`
          : `kill -TERM -- "-$(cat ${qpid} 2>/dev/null)" 2>/dev/null; rm -f ${qpid}`;
      // Fire-and-forget: the real or injected END marker completes the command.
      sshCapture(this.connection.remote, this.connection.port, killCommand, { timeoutSeconds: 10 }).catch(() => {});
    }

    if (!this.child || this.child.killed) return;
    // Backup: if the kill fails (pid file gone = already exited, or a network
    // hiccup), inject a synthetic END via the shell's stdin. The short delay
    // lets a legitimate END from a command that exits on SIGINT win the race;
    // a late orphan can never poison the next command (markers are unique).
    if (running.injectHandle) return;
    const endMarker = running.endMarker;
    running.injectHandle = setTimeout(() => {
      if (this.running === running && this.child && !this.child.killed) {
        this.child.stdin.write(`printf '\\n${endMarker}:130\\n'\n`);
      }
    }, 250);
    // Don't let the timer keep the process alive.
    running.injectHandle.unref?.();
  }

  private async execOne(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    await this.ensureStarted();
    if (!this.child || this.child.killed) {
      throw new Error("Failed to start persistent SSH shell");
    }

    const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const startMarker = `__PI_SSH_BEGIN_${unique}__`;
    const endMarker = `__PI_SSH_DONE_${unique}__`;
    const remoteCwd = mapLocalPathToRemote(cwd, this.connection);
    // The model sometimes embeds local absolute paths in the command itself
    // (copied from earlier output, or from a resumed session). Map them so the
    // command still targets the right place on the remote host.
    const remoteCommand = mapLocalPathsInCommand(command, this.connection);

    // Redirect stdin from /dev/null so commands that accidentally read from
    // stdin (e.g., bare `wc`, `read`, `cat` without args) get EOF immediately
    // instead of blocking forever on the PTY. Shell pipelines still work
    // because the pipe overrides stdin for downstream commands.
    //
    // If the command contains newlines (e.g. multi-line git commit -m "..."),
    // base64-encode it so the entire wrapper stays on a single PTY line.
    // Otherwise the PTY interprets embedded newlines as separate command
    // submissions and the end marker is never reached, hanging the session.
    // The payload is ALWAYS base64-inlined into `bash -c`: uniform quoting
    // when nested inside the tagged wrapper, and newline-safe on a single PTY
    // line (multi-line submissions make interactive shells treat each line as
    // a separate submission - the end marker is never reached).
    const payloadB64 = Buffer.from(remoteCommand).toString("base64");
    const inner = `eval "$(printf %s '${payloadB64}' | base64 -d)"`;
    const pidFile = `/tmp/.pi-ssh-pid-${unique}`;
    const abortTag = `PI_SSH_ABORT_${unique}`;

    // The payload runs as its own process-group leader (setsid, or perl's
    // POSIX::setsid on e.g. macOS) with its PID recorded, so
    // abortCurrentCommand can kill the whole tree over a one-shot SSH. With
    // neither available ("single"), abort degrades to killing the wrapper
    // bash only: children finish naturally, but the queue never hangs.
    const runnerPrefix =
      this.connection.abortMode === "setsid"
        ? "setsid -w"
        : this.connection.abortMode === "perl"
          ? "perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or exit 127' --"
          : "";
    // The whole bash -c argument is quoted as ONE unit: hand-inlining
    // nested single-quote idioms merges quote levels and the outer shell
    // ends up evaluating the payload's $(...) itself.
    const bashArg = `echo $$ > ${shellQuote(pidFile)} && exec bash -c ${shellQuote(inner)}`;
    const taggedPayload =
      (runnerPrefix ? `${runnerPrefix} ` : "") +
      `bash -c ${shellQuote(bashArg)} ${shellQuote(abortTag)} </dev/null`;

    const wrappedCommand = [
      `printf '\\n${startMarker}\\n'`,
      `if cd -- ${shellQuote(remoteCwd)}; then ${taggedPayload}; __pi_ec=$?; else __pi_ec=$?; fi`,
      `rm -f ${shellQuote(pidFile)}`,
      `printf '\\n${endMarker}:%s\\n' "$__pi_ec"`,
    ].join("; ");

    // Reset incremental streaming state for the new command
    this.streamedBytes = 0;
    this.seenStartMarker = false;
    this.startMarkerEnd = 0;

    // Apply default timeout if none specified, so a hung command can't
    // block the queue forever
    const effectiveTimeout = options.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS;

    return new Promise((resolve, reject) => {
      const running: RunningCommand = {
        startMarker,
        endMarker,
        pidFile,
        timeout: effectiveTimeout,
        onData: options.onData,
        signal: options.signal,
        aborted: false,
        timedOut: false,
        stdoutChunks: [],
        stderrChunks: [],
        resolve,
        reject,
      };

      if (effectiveTimeout > 0) {
        running.timeoutHandle = setTimeout(() => {
          running.timedOut = true;
          this.abortCurrentCommand();
        }, effectiveTimeout * 1000);
      }

      if (options.signal) {
        running.abortHandler = () => {
          running.aborted = true;
          this.abortCurrentCommand();
        };

        if (options.signal.aborted) {
          running.abortHandler();
        } else {
          options.signal.addEventListener("abort", running.abortHandler, { once: true });
        }
      }

      this.running = running;
      this.child?.stdin.write(`${wrappedCommand}\n`);
    });
  }
}

// Files up to this size are read through the persistent shell (no ssh process
// spawn). Larger files fall back to a one-shot exec: multi-MB base64 through a
// PTY makes the incremental marker parsing quadratic.
const PERSISTENT_READ_MAX_BYTES = 256 * 1024;
const PERSISTENT_WRITE_MAX_BYTES = 256 * 1024;

interface RemoteTransport {
  dispose(): Promise<void>;
  /** Open the persistent shell in the background so the first tool call skips connection setup. */
  warmup(): Promise<void>;
  exec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }>;
  readFile(remotePath: string): Promise<Buffer>;
  ensureReadable(remotePath: string): Promise<void>;
  ensureReadableWritable(remotePath: string): Promise<void>;
  detectImageMimeType(remotePath: string): Promise<string | null>;
  mkdir(remoteDir: string): Promise<void>;
  writeFile(remotePath: string, content: Buffer): Promise<void>;
}

function remoteDirname(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex <= 0) return "/";
  return path.slice(0, slashIndex);
}

// Exported for testing the byte-exact read/write paths against a live host.
export class SshTransport implements RemoteTransport {
  private connection: SshConnection;
  private shell: PersistentRemoteShell;
  private queue = new CommandQueue();

  constructor(connection: SshConnection) {
    this.connection = connection;
    this.shell = new PersistentRemoteShell(connection);
  }

  async dispose(): Promise<void> {
    await this.shell.dispose();
  }

  async warmup(): Promise<void> {
    if (this.connection.platform === "windows") {
      return; // no persistent shell on Windows
    }
    await this.queue.enqueue(async () => {
      try {
        // Best-effort: open the persistent shell now so the first tool call
        // doesn't pay PTY setup. Failures are surfaced by the real calls later.
        await this.shell.exec(":", this.connection.localCwd, { onData: () => {} });
      } catch {
        /* ignore */
      }
    });
  }

  exec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    if (this.connection.platform === "windows") {
      return this.queue.enqueue(() => this.windowsExec(command, cwd, options));
    }
    return this.queue.enqueue(() => this.shell.exec(command, cwd, options));
  }

  /**
   * Windows one-shot exec: PowerShell EncodedCommand so arbitrary command text
   * (newlines, quotes) survives cmd.exe; the script records its own PID so
   * abort/timeout can taskkill /F /T the whole tree.
   */
  private windowsExec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const pidFile = windowsPidFile(unique);
    const remoteCwd = mapLocalPathToRemote(cwd, this.connection);
    const script = [
      `$pid | Set-Content -Path ${psQuote(pidFile)}`,
      `Set-Location -LiteralPath ${psQuote(remoteCwd)}`,
      command,
    ].join("\n");
    const remote = powershellEncoded(script);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const child = spawn("ssh", [...buildSshBaseArgs(this.connection.port), this.connection.remote, remote], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      child.stdout.on("data", (c) => options.onData(c));
      child.stderr.on("data", (c) => options.onData(c));
      child.on("error", (e) => finish(() => reject(e)));
      child.on("close", (code) => finish(() => resolve({ exitCode: code })));

      const killRemote = () => {
        const kill = `for /f %i in ('type ${pidFile} 2^>nul') do taskkill /F /T /PID %i`;
        sshCapture(this.connection.remote, this.connection.port, kill, { timeoutSeconds: 10 }).catch(() => {});
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      };

      const effectiveTimeout = options.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              killRemote();
              finish(() => reject(new Error(`timeout:${effectiveTimeout}`)));
            }, effectiveTimeout * 1000)
          : undefined;

      if (options.signal) {
        const onAbort = () => {
          killRemote();
          finish(() => reject(new Error("aborted")));
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
        void timer;
      }
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    if (this.connection.platform === "windows") {
      const script = `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(remotePath)}))`;
      const out = await sshExec(this.connection.remote, this.connection.port, powershellEncoded(script), {
        timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
      });
      return Buffer.from(out.toString("utf-8").trim(), "base64");
    }
    const quotedPath = shellQuote(remotePath);
    try {
      // Fast path: one round trip through the persistent shell, no ssh spawn.
      // base64 keeps bytes exact despite PTY \r\n translation (base64 output
      // only ever contains [A-Za-z0-9+/=\n]; the shell layer normalizes \r\n
      // back to \n before we decode).
      return await this.queue.enqueue(() => this.readViaPersistentShell(quotedPath));
    } catch {
      // Fallback (oversized file, unreadable, or unexpected framing): one-shot
      // exec streams exact bytes outside the PTY. It also reproduces the real
      // error for unreadable files.
      return this.queue.enqueue(() =>
        sshExec(this.connection.remote, this.connection.port, `cat -- ${quotedPath}`, {
          timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
        }),
      );
    }
  }

  private async windowsWriteFile(remotePath: string, content: Buffer): Promise<void> {
    const dir = remoteDirname(remotePath);
    await this.runCheckedWindows(powershellEncoded(`New-Item -ItemType Directory -Force -Path ${psQuote(dir)} | Out-Null`));
    // Small payloads inline as base64 (argv limit ~32KB on Windows -> 8KB raw);
    // larger ones stream via scp from a local temp file.
    if (content.length <= 8 * 1024) {
      const script = `[IO.File]::WriteAllBytes(${psQuote(remotePath)}, [Convert]::FromBase64String('${content.toString("base64")}'))`;
      await this.runCheckedWindows(powershellEncoded(script));
      return;
    }
    const tmp = join(tmpdir(), `pi-ssh-win-${Date.now()}.bin`);
    await fsWriteFile(tmp, content);
    try {
      const scpArgs: string[] = [];
      if (this.connection.port !== null) scpArgs.push("-P", String(this.connection.port));
      scpArgs.push("-o", `ControlPath=${join(CONTROL_SOCKET_DIR, "cm-%C")}`, "-o", "StrictHostKeyChecking=accept-new");
      scpArgs.push(tmp, `${this.connection.remote}:"${remotePath.replace(/\\/g, "/")}"`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn("scp", scpArgs, { stdio: ["pipe", "pipe", "pipe"] });
        let err = "";
        child.stderr.on("data", (c) => (err += c.toString()));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `scp exit ${code}`))));
      });
    } finally {
      await fsUnlink(tmp).catch(() => {});
    }
  }

  private async runCheckedWindows(remote: string): Promise<Buffer> {
    const result = await sshCapture(this.connection.remote, this.connection.port, remote, {
      timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf-8").trim();
      throw new Error(stderr || `Windows command failed with exit code ${result.exitCode}`);
    }
    return result.stdout;
  }

  private async readViaPersistentShell(quotedPath: string): Promise<Buffer> {
    const outputChunks: Buffer[] = [];
    const abort = new AbortController();
    let sizeChecked = false;

    // First output line is the file size (from `wc -c`), followed by base64 of
    // the contents. If the size exceeds the threshold we abort mid-command —
    // Ctrl-C kills the remote base64 quickly — and the caller falls back.
    const result = await this.shell.exec(
      `__pi_sz=$(wc -c < ${quotedPath}) && printf '%s\\n' "$__pi_sz" && base64 < ${quotedPath}`,
      this.connection.localCwd,
      {
        signal: abort.signal,
        onData: (chunk) => {
          outputChunks.push(chunk);
          if (!sizeChecked) {
            const text = Buffer.concat(outputChunks).toString("utf-8");
            const newlineIndex = text.indexOf("\n");
            if (newlineIndex !== -1) {
              sizeChecked = true;
              const declaredSize = Number.parseInt(text.slice(0, newlineIndex).trim(), 10);
              if (Number.isInteger(declaredSize) && declaredSize > PERSISTENT_READ_MAX_BYTES) {
                abort.abort();
              }
            }
          }
        },
      },
    );

    if (abort.signal.aborted) {
      throw new Error("file exceeds persistent-shell read threshold");
    }
    if (result.exitCode !== 0) {
      throw new Error(`remote read failed with exit code ${result.exitCode}`);
    }

    const text = Buffer.concat(outputChunks).toString("utf-8");
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex === -1) {
      throw new Error("malformed remote read output");
    }
    const declaredSize = Number.parseInt(text.slice(0, newlineIndex).trim(), 10);
    const base64Payload = text.slice(newlineIndex + 1).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/=]*$/.test(base64Payload)) {
      throw new Error("malformed remote read output");
    }
    const buffer = Buffer.from(base64Payload, "base64");
    if (Number.isInteger(declaredSize) && buffer.length !== declaredSize) {
      throw new Error(`remote read size mismatch: expected ${declaredSize}, got ${buffer.length}`);
    }
    return buffer;
  }

  async ensureReadable(remotePath: string): Promise<void> {
    if (this.connection.platform === "windows") {
      await this.runCheckedWindows(powershellEncoded(`if (-not (Test-Path -Path ${psQuote(remotePath)})) { exit 1 }`));
      return;
    }
    await this.runChecked(`test -r ${shellQuote(remotePath)}`);
  }

  async ensureReadableWritable(remotePath: string): Promise<void> {
    if (this.connection.platform === "windows") {
      // Windows OpenSSH has no POSIX permission checks; existence is the bar.
      await this.ensureReadable(remotePath);
      return;
    }
    await this.runChecked(`test -r ${shellQuote(remotePath)} && test -w ${shellQuote(remotePath)}`);
  }

  async detectImageMimeType(remotePath: string): Promise<string | null> {
    if (this.connection.platform === "windows") {
      return null; // no `file` utility on Windows remotes (furkan-bilgin)
    }
    const result = await this.capture(`file --mime-type -b -- ${shellQuote(remotePath)} 2>/dev/null || true`);
    const mime = result.output.toString("utf-8").trim();
    if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
      return mime;
    }
    return null;
  }

  async mkdir(remoteDir: string): Promise<void> {
    if (this.connection.platform === "windows") {
      await this.runCheckedWindows(powershellEncoded(`New-Item -ItemType Directory -Force -Path ${psQuote(remoteDir)} | Out-Null`));
      return;
    }
    await this.runChecked(`mkdir -p -- ${shellQuote(remoteDir)}`);
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    if (this.connection.platform === "windows") {
      await this.windowsWriteFile(remotePath, content);
      return;
    }
    if (content.length <= PERSISTENT_WRITE_MAX_BYTES) {
      const remoteDir = remoteDirname(remotePath);
      const encodedContent = content.toString("base64");
      const command = [
        `mkdir -p -- ${shellQuote(remoteDir)}`,
        `printf '%s' ${shellQuote(encodedContent)} | base64 -d > ${shellQuote(remotePath)}`,
      ].join(" && ");

      try {
        await this.runChecked(command);
        return;
      } catch {
        // fall through to one-shot streaming fallback
      }
    }

    await this.queue.enqueue(async () => {
      const remoteDir = remoteDirname(remotePath);
      const command = [`mkdir -p -- ${shellQuote(remoteDir)}`, `cat > ${shellQuote(remotePath)}`].join(" && ");
      await sshExec(this.connection.remote, this.connection.port, command, {
        stdin: content,
      });
    });
  }

  private async capture(
    command: string,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<{ exitCode: number | null; output: Buffer }> {
    return this.queue.enqueue(async () => {
      const outputChunks: Buffer[] = [];
      const result = await this.shell.exec(command, this.connection.localCwd, {
        timeout: options.timeout,
        signal: options.signal,
        onData: (data) => {
          outputChunks.push(data);
        },
      });
      return {
        exitCode: result.exitCode,
        output: Buffer.concat(outputChunks),
      };
    });
  }

  private async runChecked(command: string, timeout?: number): Promise<Buffer> {
    const result = await this.capture(command, { timeout });
    if (result.exitCode !== 0) {
      const stderr = result.output.toString("utf-8").trim();
      throw new Error(stderr || `SSH command failed with exit code ${result.exitCode}`);
    }
    return result.output;
  }
}

function createRemoteReadOps(conn: SshConnection, transport: RemoteTransport): ReadOperations {
  // Only image extensions can be returned as inline images by the read tool;
  // gating locally avoids a remote `file --mime-type` round trip on every read.
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  return {
    readFile: async (absolutePath) => {
      // The built-in bash tool saves truncated full output to a LOCAL temp file
      // and hands the path to the model. Those files only exist on this machine,
      // so read them locally instead of over SSH.
      if (isLocalTempFilePath(absolutePath) || isProtectedLocalPath(absolutePath)) {
        return fsReadFile(absolutePath);
      }
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      return transport.readFile(remotePath);
    },
    access: async (absolutePath) => {
      if (isLocalTempFilePath(absolutePath) || isProtectedLocalPath(absolutePath)) {
        await fsAccess(absolutePath, constants.R_OK);
        return;
      }
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await transport.ensureReadable(remotePath);
    },
    detectImageMimeType: async (absolutePath) => {
      const lower = absolutePath.toLowerCase();
      if (!imageExtensions.some((ext) => lower.endsWith(ext))) {
        return null;
      }
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      try {
        return await transport.detectImageMimeType(remotePath);
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(conn: SshConnection, transport: RemoteTransport): WriteOperations {
  return {
    mkdir: async (absoluteDir) => {
      if (isProtectedLocalPath(absoluteDir)) {
        await fsMkdir(absoluteDir, { recursive: true });
        return;
      }
      const remoteDir = mapLocalPathToRemote(absoluteDir, conn);
      await transport.mkdir(remoteDir);
    },
    writeFile: async (absolutePath, content) => {
      if (isProtectedLocalPath(absolutePath)) {
        await fsWriteFile(absolutePath, content);
        return;
      }
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await transport.writeFile(remotePath, Buffer.from(content, "utf-8"));
    },
  };
}

function createRemoteEditOps(conn: SshConnection, transport: RemoteTransport): EditOperations {
  const readOps = createRemoteReadOps(conn, transport);
  const writeOps = createRemoteWriteOps(conn, transport);

  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: async (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await transport.ensureReadableWritable(remotePath);
    },
  };
}

function createRemoteBashOps(transport: RemoteTransport): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) => {
      return transport.exec(command, cwd, { onData, signal, timeout });
    },
  };
}

async function resolveSshConnection(rawFlag: string, localCwd: string, localHome: string, port: number | null): Promise<SshConnection> {
  const parsed = parseSshFlag(rawFlag);

  // Single round trip: detect HOME and resolve the remote workspace together.
  // The first SSH call also establishes the ControlMaster, so folding the two
  // probes into one command saves a full connection round trip at startup.
  // Platform detection rides along: POSIX shells print a uname; Windows cmd
  // fails uname and echoes %OS%. (Furkan-bilgin's Windows remotes support.)
  const probe = [
    "printf '%s\\n' \"$HOME\"",
    // setsid -w (wait) is required: a plain setsid can FORK when the caller
    // is already a process-group leader (interactive bash job control), and
    // then the wrapper returns before the payload even starts.
    "command -v setsid >/dev/null 2>&1 && setsid -w true 2>/dev/null && echo setsid || { command -v perl >/dev/null 2>&1 && echo perl; } || echo single",
    'uname -s 2>/dev/null || echo %OS%',
    parsed.remotePath ? buildResolveRemotePathCommand(parsed.remotePath) : 'pwd 2>/dev/null || echo %CD%',
  ].join("; ");
  const probeResult = await sshExec(parsed.remote, port, probe, { timeoutSeconds: 15 });
  const [homeLine, setsidLine, unameLine, cwdLine] = probeResult.toString("utf-8").split("\n");
  const platform = /^Windows/i.test((unameLine ?? "").trim()) ? "windows" : "posix";
  const abortModeRaw = (setsidLine ?? "").trim();
  const abortMode: SshConnection["abortMode"] =
    platform === "windows" ? "single" : abortModeRaw === "setsid" || abortModeRaw === "perl" ? abortModeRaw : "single";

  const remoteHome = (homeLine ?? "").trim();
  if (!remoteHome) {
    throw new Error("Failed to detect remote HOME");
  }

  const remoteCwd = (cwdLine ?? "").trim();
  if (!remoteCwd) {
    throw new Error(parsed.remotePath ? `Failed to resolve remote path: ${parsed.remotePath}` : "Failed to detect remote cwd");
  }

  return {
    remote: parsed.remote,
    port,
    remoteCwd,
    remoteHome,
    localCwd,
    localHome,
    abortMode,
    platform,
  };
}

/** Parse host aliases from ~/.ssh/config (skip wildcard patterns), for /ssh completions. */
function readSshConfigHosts(): string[] {
  try {
    const config = readFileSync(join(homedir(), ".ssh", "config"), "utf-8");
    const hosts: string[] = [];
    for (const line of config.split("\n")) {
      const match = /^\s*Host\s+(.+)$/i.exec(line);
      if (!match) continue;
      for (const pattern of match[1].trim().split(/\s+/)) {
        if (!pattern.includes("*") && !pattern.includes("?") && !hosts.includes(pattern)) {
          hosts.push(pattern);
        }
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

/**
 * Custom session entry type that records the active SSH target. Written on every
 * successful connect; read back on session resume so the connection survives
 * `pi --resume` / `pi -r` without re-typing `--ssh`.
 */
const CONNECTION_ENTRY_TYPE = "pi-ssh-connection";

/**
 * Pick a unique session display name for the remote target: "<remote>:<remoteCwd>".
 * When another stored session already uses the base name, append ":NN" with NN one
 * past the highest serial already taken among its numbered variants (base, base:1,
 * base:2, ...). The scan is heuristic over display names — user-renamed sessions
 * that happen to look like "<base>:<number>" count toward the serial. Falls back
 * to the base name if existing sessions can't be listed — a duplicate name is
 * cosmetic, a failed connect is not.
 */
async function computeRemoteSessionName(remote: string, remoteCwd: string): Promise<string> {
  const base = `${remote}:${remoteCwd}`;
  try {
    const sessions = await SessionManager.listAll();
    const names = sessions.map((session) => session.name).filter((name): name is string => Boolean(name));
    if (!names.includes(base)) {
      return base;
    }
    // Parse "<base>:<NN>" with string methods: remote paths can contain any
    // character that would need escaping in a RegExp.
    const numberedPrefix = `${base}:`;
    let maxSerial = 0;
    for (const name of names) {
      if (!name.startsWith(numberedPrefix)) continue;
      const serial = Number(name.slice(numberedPrefix.length));
      if (Number.isInteger(serial) && serial > maxSerial) {
        maxSerial = serial;
      }
    }
    return `${numberedPrefix}${maxSerial + 1}`;
  } catch {
    return base;
  }
}

interface SessionManagerLike {
  getBranch(): readonly unknown[];
}

/**
 * Find the most recent pi-ssh connection record in the session branch.
 * Returns null when the session was never driven over SSH (or the newest
 * record is corrupt — an invalid newest record must not resurrect an older
 * connection).
 */
export function findStoredConnection(sessionManager: SessionManagerLike): SshConnection | null {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== CONNECTION_ENTRY_TYPE) continue;

    const data = entry.data as Partial<SshConnection> | undefined;
    if (
      !data ||
      typeof data.remote !== "string" ||
      data.remote.length === 0 ||
      typeof data.remoteCwd !== "string" ||
      data.remoteCwd.length === 0 ||
      typeof data.remoteHome !== "string"
    ) {
      return null;
    }

    // Old records always stored a concrete port (22 was force-applied); treat
    // a stored 22 as "no explicit port" so ~/.ssh/config Port directives win.
    let port: number | null;
    if (data.port === null || data.port === undefined || Number(data.port) === 22) {
      port = null;
    } else {
      try {
        port = parseSshPort(String(data.port));
      } catch {
        return null;
      }
    }

    // Rebuild with the CURRENT local cwd/home: tools resolve relative paths
    // against this pi process, and mapLocalPathToRemote needs both sides to
    // line up. Only the remote side of the mapping is restored from the record.
    return {
      remote: data.remote,
      port,
      remoteCwd: data.remoteCwd,
      remoteHome: data.remoteHome,
      localCwd: process.cwd(),
      localHome: homedir(),
      // Records written before these fields existed target Linux remotes.
      abortMode: data.abortMode ?? ((data as { hasSetsid?: boolean }).hasSetsid === false ? "single" : "setsid"),
      platform: data.platform === "windows" ? "windows" : "posix",
    };
  }
  return null;
}

// ---- Remote @-file completion ----
// pi's @-completion only INSERTS a path into the message; the model then reads
// it with the read tool, which already routes to the remote host in SSH mode.
// So "make @ load remote files" = complete against a cached remote listing.

interface RemoteFileList {
  at: number;
  files: string[];
}

const REMOTE_LIST_TTL_MS = 60_000;
const remoteListCache = new Map<string, RemoteFileList>();
let remoteListInflight: Promise<string[] | null> | null = null;

/** Extract the @token at the cursor, or null when the cursor is not on one. */
function extractAtToken(line: string | undefined, cursorCol: number): string | null {
  if (!line) return null;
  const match = /(?:^|[\s(\[{'"])@(\S*)$/.exec(line.slice(0, cursorCol));
  return match ? `@${match[1]}` : null;
}

function filterRemoteFiles(files: string[], partial: string): string[] {
  const needle = partial.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx === -1) continue;
    scored.push({ path: file, score: idx * 1000 + file.length });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 20).map((entry) => entry.path);
}

async function getRemoteFileList(conn: SshConnection, tr: RemoteTransport): Promise<string[] | null> {
  const cacheKey = `${conn.remote}:${conn.remoteCwd}`;
  const cached = remoteListCache.get(cacheKey);
  if (cached && Date.now() - cached.at < REMOTE_LIST_TTL_MS) {
    return cached.files;
  }
  if (remoteListInflight) return remoteListInflight;

  remoteListInflight = (async () => {
    try {
      // fd when available (fast, respects .gitignore-ish excludes), find fallback.
      const cmd =
        `cd -- ${shellQuote(conn.remoteCwd)} && ` +
        `if command -v fd >/dev/null 2>&1; then fd --hidden --exclude .git --max-results 5000; ` +
        `else find . -path ./.git -prune -o -print 2>/dev/null | head -n 5000; fi`;
      const output: string[] = [];
      const result = await tr.exec(cmd, conn.localCwd, {
        onData: (chunk) => output.push(chunk.toString("utf-8")),
        timeout: 20,
      });
      if (result.exitCode !== 0) return null;
      const files = output
        .join("")
        .split("\n")
        .map((line) => line.replace(/^\.\//, "").trim())
        .filter((line) => line.length > 0 && line !== ".");
      remoteListCache.set(cacheKey, { at: Date.now(), files });
      return files;
    } catch {
      return null;
    } finally {
      remoteListInflight = null;
    }
  })();
  return remoteListInflight;
}

export default function piSshExtension(pi: ExtensionAPI): void {
  pi.registerFlag("ssh", {
    description: "SSH target as user@host or user@host:/absolute/remote/path",
    type: "string",
  });
  pi.registerFlag("ssh-port", {
    description: "SSH port (default: honor ~/.ssh/config / ssh default)",
    type: "string",
  });
  pi.registerFlag("p", {
    description: "Alias for --ssh-port",
    type: "string",
  });

  const localCwd = process.cwd();
  const localHome = homedir();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let connection: SshConnection | null = null;
  let transport: SshTransport | null = null;
  // True when THIS extension instance created the transport. Sub-agent
  // instances inherit the parent's transport via the process-wide global and
  // must not dispose it on shutdown.
  let ownsTransport = false;
  // Remote AGENTS.md / CLAUDE.md content (PR #8), injected as a system-prompt
  // section; null when absent or disconnected.
  let remoteContext: string | null = null;

  // --- pi-subagents interop (furkan-bilgin): sub-agents run as new pi
  // sessions in this process with no --ssh flag and an empty session; they
  // would otherwise start in local mode. Publish the active connection in a
  // process-wide slot so child sessions can inherit it read-only.
  const GLOBAL_KEY = Symbol.for("pi-ssh:global");
  const getGlobal = (): { connection: SshConnection; transport: SshTransport } | null =>
    (globalThis as any)[GLOBAL_KEY] ?? null;
  const setGlobal = (value: { connection: SshConnection; transport: SshTransport } | null) => {
    if (value) (globalThis as any)[GLOBAL_KEY] = value;
    else delete (globalThis as any)[GLOBAL_KEY];
  };

  const getConnection = () => connection ?? getGlobal()?.connection ?? null;
  const getTransport = () => transport ?? getGlobal()?.transport ?? null;

  // Tool overrides are registered lazily (danyx23): a pure-local session keeps
  // pi's built-in read/write/edit/bash untouched. Registered once, on the first
  // successful connect (including sub-agent inheritance).
  let toolsRegistered = false;
  const ensureToolsRegistered = () => {
    if (toolsRegistered) return;
    toolsRegistered = true;

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      const conn = getConnection();
      const tr = getTransport();
      if (!conn || !tr) {
        return localRead.execute(id, params, signal, onUpdate);
      }
      const tool = createReadTool(localCwd, { operations: createRemoteReadOps(conn, tr) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const conn = getConnection();
      const tr = getTransport();
      if (!conn || !tr) {
        return localWrite.execute(id, params, signal, onUpdate);
      }
      const tool = createWriteTool(localCwd, { operations: createRemoteWriteOps(conn, tr) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const conn = getConnection();
      const tr = getTransport();
      if (!conn || !tr) {
        return localEdit.execute(id, params, signal, onUpdate);
      }
      const tool = createEditTool(localCwd, { operations: createRemoteEditOps(conn, tr) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      const tr = getTransport();
      if (!tr) {
        return localBash.execute(id, params, signal, onUpdate);
      }
      const tool = createBashTool(localCwd, { operations: createRemoteBashOps(tr) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  };
  const ensureToolsRegisteredRef = ensureToolsRegistered;
  void ensureToolsRegisteredRef;

  const statusLine = (conn: SshConnection) =>
    `SSH ${conn.remote}:${conn.remoteCwd} (port ${conn.port ?? "ssh-config"})`;

  async function loadRemoteContext(tr: SshTransport, conn: SshConnection): Promise<string | null> {
    // PR #8 (smithtim): pi's resource loader reads AGENTS.md/CLAUDE.md from the
    // LOCAL filesystem, so remote project context is invisible. Fetch it from
    // the remote cwd and surface it as a dedicated system-prompt section.
    const parts: string[] = [];
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const buf = await tr.readFile(`${conn.remoteCwd}/${name}`);
        const text = buf.toString("utf-8").trim();
        if (text) {
          parts.push(
            `<remote_project_context source="${conn.remote}:${conn.remoteCwd}/${name}">\n${text.slice(0, 24_000)}\n</remote_project_context>`,
          );
        }
      } catch {
        /* file absent on the remote - fine */
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  async function activateConnection(conn: SshConnection, ctx: any, via: string): Promise<void> {
    if (transport && ownsTransport) {
      await transport.dispose();
    }
    connection = conn;
    transport = new SshTransport(conn);
    ownsTransport = true;
    ensureToolsRegistered();
    setGlobal({ connection: conn, transport });
    // (Re)record the connection so future resumes reconnect. Latest entry wins.
    pi.appendEntry(CONNECTION_ENTRY_TYPE, conn);
    // Open the persistent shell in the background so the first tool call
    // doesn't pay connection setup. Remote context loads over the same shell.
    void transport.warmup();
    // Name the session after the remote target so multiple remote sessions are
    // distinguishable in the session selector. Only when the session has no
    // name yet: session_start also fires on resume, and re-computing there
    // would find the session's own name "taken" and shift it to the next
    // serial. Never clobber a user-set name either.
    //
    // Fire-and-forget: computing the name lists every stored session, which
    // must not delay warmup or the remote-context load. Two sessions started
    // concurrently to the same target can race and pick the same name — the
    // duplicate is cosmetic and the naming scan is heuristic anyway.
    if (!pi.getSessionName()) {
      void computeRemoteSessionName(conn.remote, conn.remoteCwd)
        .then((name) => pi.setSessionName(name))
        .catch(() => {
          /* naming is best-effort */
        });
    }
    remoteContext = await loadRemoteContext(transport, conn);

    const message = `pi-ssh ${via}: ${conn.remote}:${conn.remoteCwd} (port ${conn.port ?? "ssh-config"})`;
    console.log(message);
    if (ctx?.hasUI) {
      ctx.ui.setStatus("pi-ssh", ctx.ui.theme.fg("accent", statusLine(conn)));
      ctx.ui.notify(message, "info");
    }
  }

  async function deactivateConnection(ctx: any): Promise<void> {
    if (transport && ownsTransport) {
      await transport.dispose();
    }
    transport = null;
    connection = null;
    ownsTransport = false;
    remoteContext = null;
    // Explicit disconnect: publish an empty global immediately (so later
    // sub-agents don't inherit a stale target) and record a tombstone entry -
    // findStoredConnection treats the newest invalid record as "no SSH" and
    // will NOT fall back to older records.
    setGlobal(null);
    pi.appendEntry(CONNECTION_ENTRY_TYPE, { disconnected: true });
    if (ctx?.hasUI) {
      ctx.ui.setStatus("pi-ssh", undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // A switch / new / fork / resume invalidates any transport THIS instance owns.
    if (transport && ownsTransport) {
      await transport.dispose();
    }
    transport = null;
    connection = null;
    ownsTransport = false;
    remoteContext = null;

    const flag = pi.getFlag("ssh") as string | undefined;
    const portFlag = (pi.getFlag("p") as string | undefined) ?? (pi.getFlag("ssh-port") as string | undefined);
    const port = portFlag !== undefined ? parseSshPort(portFlag) : null;

    try {
      if (flag) {
        await activateConnection(await resolveSshConnection(flag, localCwd, localHome, port), ctx, "enabled");
      } else {
        // No --ssh flag: reconnect from the connection record stored in the
        // session (written the last time this session ran with --ssh).
        const stored = findStoredConnection(ctx.sessionManager);
        if (stored) {
          await activateConnection(stored, ctx, "resumed");
        } else {
          // Sub-agent fallback (pi-subagents interop): inherit the parent's
          // connection read-only. ownsTransport stays false, so shutdown here
          // never disposes the parent's transport.
          const g = getGlobal();
          if (g) {
            connection = g.connection;
            transport = g.transport;
            ensureToolsRegistered();
            console.log(`pi-ssh inherited for sub-agent: ${g.connection.remote}:${g.connection.remoteCwd}`);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connection = null;
      if (transport && ownsTransport) {
        await transport.dispose();
      }
      transport = null;
      ownsTransport = false;
      console.error(`pi-ssh failed to connect: ${message}`);
      if (ctx?.hasUI) {
        ctx.ui.setStatus("pi-ssh", undefined);
        ctx.ui.notify(`pi-ssh failed to connect: ${message}`, "error");
      }
      // An explicit --ssh failure is fatal on startup; a failed resume just
      // falls back to local mode so the session can still be opened/read.
      if (flag) throw error;
    }
  });

  pi.on("session_shutdown", async () => {
    // Sub-agents inherit the parent's transport: only dispose what we own.
    // The global deliberately survives shutdown so sub-agents that outlive
    // this turn can still inherit; it is replaced on the next connect.
    if (transport && ownsTransport) {
      await transport.dispose();
    }
    transport = null;
    connection = null;
    ownsTransport = false;
  });

  pi.on("user_bash", () => {
    const tr = getTransport();
    if (!tr) return;
    return { operations: createRemoteBashOps(tr) };
  });

  pi.on("before_agent_start", async (event) => {
    const conn = getConnection();
    if (!conn) return;

    // pi renders the session cwd into its own <cwd> system-prompt section
    // ("<cwd>\n<path>\n</cwd>"). The supported override is mutating
    // event.systemPromptOptions.cwd: the section is re-rendered, diffed, and
    // persisted with the transcript, so the model sees the remote cwd from the
    // first turn and after session resume. (A previous version tried to replace
    // the literal string "Current working directory: <path>", which never
    // appears in the rendered prompt, so the rewrite silently did nothing.)
    if (event.systemPromptOptions.cwd !== localCwd) return; // another extension customized cwd

    event.systemPromptOptions.cwd = [
      conn.remoteCwd,
      `All tools (read, write, edit, bash) execute on remote host ${conn.remote} over SSH. This pi process runs locally in ${localCwd}, which does not exist on the remote host. Always use remote absolute paths; local paths under ${localCwd} and ${localHome} are transparently mapped to their remote equivalents.`,
    ].join("\n\n");

    // Remote project context (PR #8) renders after <cwd>, i.e. at the very end
    // of the prompt, so it wins over local project instructions on conflict.
    if (remoteContext) {
      // Cast: the earendil runtime supports custom sections here; the
      // @mariozechner type definitions this file typechecks against lag it.
      const options = event.systemPromptOptions as BuildSystemPromptOptions & {
        sections?: Record<string, string>;
      };
      options.sections = { ...options.sections, ssh_context: remoteContext };
    }
  });

  // ---- Remote @-file completion: wrap pi's autocomplete provider so @
  // suggests files on the remote host (relative to the remote cwd, so the
  // model's read call maps straight through mapLocalPathToRemote) ----
  try {
    // Cast: the earendil runtime ships addAutocompleteProvider; the
    // @mariozechner type definitions this file typechecks against lag it.
    const piTui = pi as ExtensionAPI & {
      addAutocompleteProvider?(factory: (current: any) => any): void;
    };
    piTui.addAutocompleteProvider?.((current: any) => ({
      getSuggestions: async (lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal }) => {
        const conn = getConnection();
        const tr = getTransport();
        if (!conn || !tr || conn.platform === "windows") {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
        const token = extractAtToken(lines[cursorLine], cursorCol);
        if (token === null) {
          // Not an @ token: delegate (slash commands, other completions).
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
        const files = await getRemoteFileList(conn, tr);
        if (options.signal.aborted) return null;
        if (!files) return null;
        const items = filterRemoteFiles(files, token.slice(1)).map((path) => ({ value: path, label: path }));
        return { items, prefix: token };
      },
      applyCompletion: (lines: string[], cursorLine: number, cursorCol: number, item: any, prefix: string) =>
        current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
      shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
    }));
  } catch {
    // addAutocompleteProvider is TUI-only; print/RPC modes simply skip it.
  }

  // ---- /ssh command (pansapiens): connect, switch, status, disconnect
  // mid-session without restarting pi ----
  pi.registerCommand("ssh", {
    description: "SSH remote tools: /ssh [user@host[:/path]], /ssh status, /ssh off",
    getArgumentCompletions: (prefix: string) => {
      const options = ["off", "status", ...readSshConfigHosts()];
      const filtered = options.filter((option) => option.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const input = args.trim();

      if (input === "status" || (!input && !connection)) {
        if (!getConnection()) {
          ctx.ui.notify("pi-ssh: not connected (local tools active)", "info");
        } else {
          ctx.ui.notify(`pi-ssh: ${statusLine(getConnection()!)}`, "info");
        }
        return;
      }

      if (input === "off") {
        if (!getConnection()) {
          ctx.ui.notify("pi-ssh: already off", "info");
          return;
        }
        await deactivateConnection(ctx);
        ctx.ui.notify("pi-ssh: disconnected", "info");
        return;
      }

      let target = input;
      if (!target) {
        // No args and connected -> status was handled above; offer host picker.
        const hosts = readSshConfigHosts();
        if (hosts.length === 0) {
          ctx.ui.notify("Usage: /ssh user@host[:/path] (or /ssh off, /ssh status)", "warning");
          return;
        }
        const picked = await ctx.ui.select("SSH target", ["off", ...hosts]);
        if (!picked) return;
        if (picked === "off") {
          await deactivateConnection(ctx);
          ctx.ui.notify("pi-ssh: disconnected", "info");
          return;
        }
        target = picked;
      }

      try {
        const portFlag = (pi.getFlag("p") as string | undefined) ?? (pi.getFlag("ssh-port") as string | undefined);
        const port = portFlag !== undefined ? parseSshPort(portFlag) : null;
        await activateConnection(await resolveSshConnection(target, localCwd, localHome, port), ctx, "connected");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-ssh failed to connect: ${message}`, "error");
      }
    },
  });

}
