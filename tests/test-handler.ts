import { createRequire } from "node:module";
// Load the extension source directly
const mod = await import("./index.ts");
const registerSsh = mod.default;

function makeMockPi(flags: Record<string, string>) {
  const handlers: Record<string, Function[]> = {};
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerFlag: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    getFlag: (name: string) => flags[name],
    appendEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); },
    on: (event: string, handler: Function) => { (handlers[event] ??= []).push(handler); },
  };
  return { pi, handlers, appended };
}

let fail = 0;
function check(name: string, cond: boolean) {
  if (!cond) { fail++; console.log(`FAIL: ${name}`); } else console.log(`ok: ${name}`);
}

const recorded = {
  remote: "yangye@my-vm", port: 2222,
  remoteCwd: "/var/home/yangye/devv/dongli/transcribe/rust-transcribe",
  remoteHome: "/var/home/yangye",
  localCwd: "/Users/yangye/devv/123", localHome: "/Users/yangye",
};
const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data, id: "x", timestamp: Date.now() });

// --- Scenario 1: resume without --ssh flag, session has a record ---
{
  const { pi, handlers, appended } = makeMockPi({});
  registerSsh(pi as any);
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [entry("pi-ssh-connection", recorded)] } };
  let logged = "";
  const origLog = console.log; console.log = (m: string) => { logged = m; };
  await handlers["session_start"][0]({ type: "session_start", reason: "resume" }, ctx);
  console.log = origLog;
  check("resume: announces reconnect", logged.includes("pi-ssh resumed: yangye@my-vm:/var/home/yangye/devv/dongli/transcribe/rust-transcribe (port 2222)"));
  check("resume: records refreshed entry", appended.length === 1 && appended[0].customType === "pi-ssh-connection" && (appended[0].data as any).remote === "yangye@my-vm");
  // before_agent_start now rewrites cwd to the resumed remote
  let captured: any = null;
  const event = { systemPromptOptions: { cwd: process.cwd() } };
  // grab the handler (it's the only before_agent_start handler)
  await handlers["before_agent_start"][0](event);
  captured = event.systemPromptOptions.cwd;
  check("resume: cwd rewritten to remote", typeof captured === "string" && captured.startsWith("/var/home/yangye/devv/dongli/transcribe/rust-transcribe"));
}

// --- Scenario 2: resume without flag, session has NO record (plain session) ---
{
  const { pi, handlers, appended } = makeMockPi({});
  registerSsh(pi as any);
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
  await handlers["session_start"][0]({ type: "session_start", reason: "resume" }, ctx);
  check("plain session: stays local, nothing recorded", appended.length === 0);
}

// --- Scenario 3: flag present -> records connection for future resumes ---
// Use an unreachable host so resolveSshConnection fails fast without network side effects;
// the flag path is fatal, so we expect a throw — but appendEntry must NOT fire on failure.
{
  const { pi, handlers, appended } = makeMockPi({ ssh: "nobody@pi-ssh-test.invalid" });
  registerSsh(pi as any);
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
  let threw = false;
  try {
    await Promise.race([
      handlers["session_start"][0]({ type: "session_start", reason: "startup" }, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
    ]);
  } catch { threw = true; }
  check("flag path: fatal on connect failure", threw);
  check("flag path: nothing recorded on failure", appended.length === 0);
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
