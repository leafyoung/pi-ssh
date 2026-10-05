import { parseSshFlag } from "./index.ts";
let fail = 0;
const cases: Array<[string, string, string | undefined]> = [
  ["user@host:C:\\Users\\me", "user@host", "C:\\Users\\me"],
  ["user@host:C:/Users/me/project", "user@host", "C:/Users/me/project"],
  ["host:/abs/path", "host", "/abs/path"],
  ["host", "host", undefined],
  ["host:~/x", "host", "~/x"],
  ["yangye@ap308:/var/home/yangye", "yangye@ap308", "/var/home/yangye"],
];
for (const [input, remote, path] of cases) {
  const got = parseSshFlag(input);
  const ok = got.remote === remote && got.remotePath === path;
  if (!ok) { fail++; console.log(`FAIL ${input}\n  got ${JSON.stringify(got)}`); } else console.log(`ok: ${input}`);
}
console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
