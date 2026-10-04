import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { SshTransport } from "./index.ts";

const REMOTE_DIR = "/tmp/pi-ssh-e2e";
rmSync(REMOTE_DIR, { recursive: true, force: true });
mkdirSync(`${REMOTE_DIR}/fixture`, { recursive: true });
const smallBin = randomBytes(64 * 1024);
writeFileSync(`${REMOTE_DIR}/fixture/bin-small`, smallBin);
const textContent = "héllo wörld\r\nwith crlf\nand ünïcode ✓\n".repeat(100);
writeFileSync(`${REMOTE_DIR}/fixture/text.txt`, textContent, "utf-8");
const bigBin = randomBytes(300 * 1024); // > 256KB threshold -> one-shot fallback
writeFileSync(`${REMOTE_DIR}/fixture/bin-big`, bigBin);
writeFileSync(`${REMOTE_DIR}/fixture/empty`, Buffer.alloc(0));

// push fixtures to the remote host
import { execSync } from "node:child_process";
execSync(`ssh ap308 'mkdir -p ${REMOTE_DIR}/fixture'`);
for (const f of ["bin-small", "text.txt", "bin-big", "empty"]) {
  execSync(`cat ${REMOTE_DIR}/fixture/${f} | ssh ap308 'cat > ${REMOTE_DIR}/fixture/${f}'`);
}

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  if (!cond) { fail++; console.log(`FAIL: ${name} ${extra}`); } else console.log(`ok: ${name}${extra ? ` (${extra})` : ""}`);
};

// ---------- transport-level: binary-exact reads ----------
const conn = {
  remote: "ap308", port: 22,
  remoteCwd: REMOTE_DIR, remoteHome: process.env.HOME!,
  localCwd: process.cwd(), localHome: process.env.HOME!,
};
const transport = new SshTransport(conn);
try {
  let t0 = Date.now();
  const buf1 = await transport.readFile(`${REMOTE_DIR}/fixture/bin-small`);
  check("PTY base64 read byte-exact (64KB binary)", buf1.equals(smallBin), `${Date.now() - t0}ms`);

  t0 = Date.now();
  const empty = await transport.readFile(`${REMOTE_DIR}/fixture/empty`);
  check("empty file", empty.length === 0, `${Date.now() - t0}ms`);

  t0 = Date.now();
  const bufBig = await transport.readFile(`${REMOTE_DIR}/fixture/bin-big`);
  check("oversized read falls back one-shot, byte-exact", bufBig.equals(bigBin), `${Date.now() - t0}ms`);

  t0 = Date.now();
  let missingThrew = false;
  try { await transport.readFile(`${REMOTE_DIR}/fixture/nope.txt`); } catch { missingThrew = true; }
  check("missing file throws", missingThrew, `${Date.now() - t0}ms`);

  // write -> read roundtrip, binary exact
  const wdata = randomBytes(10 * 1024);
  await transport.writeFile(`${REMOTE_DIR}/fixture/written.bin`, wdata);
  const back = await transport.readFile(`${REMOTE_DIR}/fixture/written.bin`);
  check("write/read roundtrip byte-exact", back.equals(wdata));
} finally {
  await transport.dispose();
}

// ---------- tool-level: text + bash + abort resilience ----------
const mod = await import("./index.ts");
const tools: any[] = [];
const handlers: Record<string, Function[]> = {};
const pi = {
  registerFlag: () => {},
  registerCommand: () => {},
  registerTool: (t: any) => tools.push(t),
  getFlag: (n: string) => (n === "ssh" ? `ap308:${REMOTE_DIR}` : undefined),
  appendEntry: () => {},
  on: (e: string, h: Function) => { (handlers[e] ??= []).push(h); },
};
mod.default(pi as any);
const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
await handlers["session_start"][0]({ type: "session_start", reason: "startup" }, ctx);
const tool = (name: string) => tools.find((t) => t.name === name)!;
const local = (f: string) => `${process.cwd()}/fixture/${f}`;

const r3 = await tool("read").execute("t3", { path: local("text.txt") }, undefined, undefined, undefined);
check("text read: crlf + unicode intact through tool", r3.content[0].text.includes("héllo wörld\r\nwith crlf") && r3.content[0].text.includes("ünïcode ✓"));

const r6 = await tool("bash").execute("t6", { command: `printf 'hello-from-remote'` }, undefined, undefined, undefined);
check("bash works", (r6.output ?? r6.content?.[0]?.text ?? "").includes("hello-from-remote") === true);

// abort a sleeping command: must return quickly AND leave the queue healthy
{
  const ac = new AbortController();
  const t0 = Date.now();
  const sleepPromise = tool("bash").execute("t-abort", { command: "sleep 30" }, ac.signal, undefined, undefined);
  setTimeout(() => ac.abort(), 300);
  let aborted = false;
  try { await sleepPromise; } catch (e: any) { aborted = /abort/i.test(e?.message ?? ""); if (!aborted) console.log("  abort error was:", e?.message); }
  const dt = Date.now() - t0;
  check("abort returns quickly", aborted && dt < 5000, `${dt}ms`);
  const after = await tool("bash").execute("t-after", { command: "echo queue-alive" }, undefined, undefined, undefined);
  check("queue healthy after abort", (after.output ?? after.content?.[0]?.text ?? "").includes("queue-alive") === true);
}

await handlers["session_shutdown"][0]({}, ctx);
rmSync(REMOTE_DIR, { recursive: true, force: true });
execSync(`ssh ap308 'rm -rf ${REMOTE_DIR}'`);
console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
