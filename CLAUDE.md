See [REQUIREMENTS.md](REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) for the app, how it works and the rules.
@AGENTS.md
@.claude/harness-rules.md
Typecheck: `npm run lint --silent` (runs `tsc` only; no linter is configured). Unit tests: `npm test --silent` (Node test runner over `tests/*.test.ts` and `packages/ticket-scanner/tests/*.test.ts`). Run both before committing.
Harness state lives in `.spec/`, starting with `.spec/SESSION_HANDOFF.md`. AGENTS.md wins over harness rules.
