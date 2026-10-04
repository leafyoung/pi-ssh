# pi-ssh tests

Live integration tests — they drive a real SSH host.

- `test-resume.ts` — stored-connection record parsing (offline)
- `test-handler.ts` — session_start lifecycle against a mock pi API (offline)
- `test-e2e.ts` — full transport + tool stack against `localhost` (requires passwordless localhost SSH)
- `test-e2e-ap308.ts` — same suite against the `ap308` host (Linux/bash)

Run with `bun run tests/<file>.ts` from a checkout with `@mariozechner/pi-coding-agent` importable.
Offline fixtures are created under `/tmp/pi-ssh-e2e*` and cleaned up afterwards.
