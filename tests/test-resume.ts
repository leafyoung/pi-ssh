import { homedir } from "node:os";
import { findStoredConnection } from "./index.ts";

const recorded = {
  remote: "yangye@my-vm",
  port: 2222,
  remoteCwd: "/var/home/yangye/devv/dongli/transcribe/rust-transcribe",
  remoteHome: "/var/home/yangye",
  localCwd: "/Users/yangye/devv/123",
  localHome: "/Users/yangye",
};
const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data, id: "x", timestamp: Date.now() });
const msg = { type: "message" as const, id: "m", timestamp: 0 };

let fail = 0;
function check(name: string, got: unknown, expected: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`FAIL ${name}\n  got: ${JSON.stringify(got)}\n  exp: ${JSON.stringify(expected)}`); }
  else console.log(`ok: ${name}`);
}

// 1. Session with a recorded connection -> found
const sm1 = { getBranch: () => [msg, entry("pi-ssh-connection", recorded), msg] };
const c1 = findStoredConnection(sm1);
check("finds record", c1 && { remote: c1.remote, port: c1.port, remoteCwd: c1.remoteCwd, remoteHome: c1.remoteHome }, { remote: recorded.remote, port: 2222, remoteCwd: recorded.remoteCwd, remoteHome: recorded.remoteHome });
// local side must be rebuilt from THIS process
check("local side rebuilt", c1?.localCwd === process.cwd() && c1?.localHome === homedir(), true);

// 2. Plain session -> null
const sm2 = { getBranch: () => [msg, msg] };
check("no record -> null", findStoredConnection(sm2), null);

// 3. Corrupt newest record -> null (no resurrection of older record)
const sm3 = { getBranch: () => [entry("pi-ssh-connection", recorded), entry("pi-ssh-connection", { remote: "" })] };
check("corrupt newest -> null", findStoredConnection(sm3), null);

// 4. Non-ssh custom entries are skipped
const sm4 = { getBranch: () => [entry("other-thing", recorded), entry("pi-ssh-connection", recorded)] };
check("other custom entries ignored", findStoredConnection(sm4)?.remote, recorded.remote);

// 5. Latest of several records wins
const newer = { ...recorded, remote: "yangye@other-vm", remoteCwd: "/tmp" };
const sm5 = { getBranch: () => [entry("pi-ssh-connection", recorded), entry("pi-ssh-connection", newer)] };
check("latest wins", findStoredConnection(sm5)?.remote, "yangye@other-vm");

// 6. Bad port falls back to 22
const sm6 = { getBranch: () => [entry("pi-ssh-connection", { ...recorded, port: "garbage" })] };
check("bad port -> null (corrupt record)", findStoredConnection(sm6), null);

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
