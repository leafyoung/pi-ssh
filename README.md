# pi-ssh

Run pi locally, work on files remotely over SSH.

`pi-ssh` is a pi extension that gives you a Cursor-like remote SSH workflow:

- pi runs on your local machine
- model access, API keys, and billing stay local
- `read`, `write`, `edit`, and `bash` run on a remote host via SSH

## Why

This is useful when:

- your code/checkouts live on a VM
- your model/tooling access is easier locally
- you want one local account to drive many remote workspaces

## Features

- `--ssh user@host` or `--ssh user@host:/remote/path`
- optional port: `--ssh-port 2222` (alias: `-p 2222`, default: `22`)
- Remote tool delegation for:
  - `read`
  - `write`
  - `edit`
  - `bash`
- SSH connection multiplexing (`ControlMaster`/`ControlPersist`) for faster repeated tool calls
- Persistent remote shell session for bash commands
  - uses your remote account's configured login shell (for example zsh)
  - environment persists across commands (for example `export TEST=123`)
  - Ctrl-C interrupts the current remote command but keeps the SSH session alive
- Remote execution for user `!` commands
- Status indicator in the pi UI when SSH mode is active
- System prompt cwd rewrite: the `<cwd>` prompt section shows the remote cwd, so the model works remotely from the first turn
- Session persistence: the connection is recorded in the session file, so `pi -r` / resume reconnects automatically without re-typing `--ssh`
- Local paths inside bash commands (and local temp-file paths from truncated output) are transparently mapped/redirected
- `/ssh [user@host[:/path] | status | off]` command to connect, switch, or disconnect mid-session (completions from `~/.ssh/config`)
- Reliable aborts: each payload runs in its own process group (`setsid -w`, or perl's `POSIX::setsid` on macOS); Esc/Ctrl-C kills the tree over a one-shot SSH instead of relying on the TTY (which interactive line editors like zsh's ZLE swallow)
- Shell-readiness handshake so the first command can't race remote shell startup
- Remote `AGENTS.md` / `CLAUDE.md` from the remote cwd are surfaced to the model as a `<ssh_context>` prompt section
- `@` file completion completes against the remote workspace (pi's `@` inserts a path; the read tool fetches it remotely)
- pi-subagents interop: sub-agent sessions inherit the parent's SSH connection automatically
- `HISTFILE=/dev/null` on the remote shell: no `.bash_history` pollution

## Requirements

- SSH client installed locally
- Passwordless SSH auth recommended (keys/agent)
- Remote host with:
  - a standard login shell (for example `zsh` or `bash`)
  - `cat`, `test`, `mkdir`, `pwd`
  - optional: `file` (for image mime detection)

## Install

### Option A: project-local extension

```bash
mkdir -p .pi/extensions
cp /path/to/pi-ssh/index.ts .pi/extensions/pi-ssh.ts
```

Then start pi in your project and pass `--ssh`.

### Option B: global extension

```bash
mkdir -p ~/.pi/agent/extensions
cp /path/to/pi-ssh/index.ts ~/.pi/agent/extensions/pi-ssh.ts
```

## Usage

### Use remote host default cwd

```bash
pi --ssh user@my-vm
# same, explicit default
pi --ssh user@my-vm --ssh-port 22
```

### Use explicit remote workspace path

```bash
pi --ssh user@my-vm:/home/user/chromium/src
# custom port
pi --ssh user@my-vm:/home/user/chromium/src -p 2222
```

You should see a status line similar to:

```text
SSH user@my-vm:/home/user/chromium/src (port 22)
```

## Session persistence / resume

When a connection is established, pi-ssh writes a `pi-ssh-connection` record into the session file (a custom entry, not sent to the LLM). When you later resume that session without `--ssh`, the extension reconnects to the recorded target automatically:

```bash
pi --ssh user@my-vm:/work/src   # first time: connects and records
pi -r                           # later: resumes and reconnects to user@my-vm:/work/src
```

- An explicit `--ssh` flag always wins over the stored record.
- If the stored host is unreachable at resume time, the session still opens (in local mode) with an error notification.
- `/new` starts a fresh session with no record, so it does not silently reconnect; forks inherit the record from the branch.
- The record contains host, port, and paths only — authentication stays with your local SSH agent/keys.

## Typical workflow

1. Start pi locally with `--ssh ...`
2. Ask pi to inspect/edit files as usual
3. All tool operations run remotely
4. Keep local model switching, auth, and limits as usual

## Windows remotes

Windows hosts are supported (after furkan-bilgin's fork): pi-ssh detects the
platform during the startup probe (`uname -s` fails, `%OS%` echoes) and then

- runs every operation as a one-shot `ssh` exec with a PowerShell
  `-EncodedCommand` payload (no persistent shell - Windows OpenSSH always
  lands in an interactive cmd.exe),
- aborts with `taskkill /F /T /PID`: the payload records its own PID, because
  Windows OpenSSH orphans remote processes when the local client disconnects,
- reads files via PowerShell base64, writes small files inline and larger
  ones via `scp` from a local temp file,
- parses Windows targets correctly: `--ssh user@host:C:\Users\me` (the drive
  colon is not mistaken for the host separator).

Image mime detection returns null (no `file` utility). Not exercised in CI;
report issues against the Windows paths specifically.

## Notes

- Absolute paths are strongly recommended for the remote path.
- Paths under local `$HOME` are mapped to remote `$HOME` in SSH mode (for example `~/.config/...`).
- If `--ssh` is not set, extension falls back to local tool behavior.
- Current version focuses on core coding tools (`read/write/edit/bash`).

## Troubleshooting

### "pi-ssh failed to connect"

Check:

```bash
ssh user@host
ssh user@host 'pwd'
```

### Commands work locally but not remotely

Verify remote shell tools exist:

```bash
ssh user@host 'which cat test mkdir pwd'
```

### Slow tool calls

`bash`/`!` and most `read`/`write`/`edit` operations use a shared persistent SSH session.
Very large writes fall back to one-shot SSH streaming for reliability.

## Development

- Spec: `extension-spec.md`
- Extension entry: `index.ts`

## License

MIT
