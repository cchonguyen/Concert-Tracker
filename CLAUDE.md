See [REQUIREMENTS.md](REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) for the app, how it works and the rules.
@AGENTS.md
@.claude/harness-rules.md
Typecheck and lint: `npm run lint --silent`. Unit tests: `npm test --silent` (Node's test runner over `tests/*.test.ts`). Run both before committing.
Harness state lives in `.spec/`, starting with `.spec/SESSION_HANDOFF.md`. AGENTS.md wins over harness rules.
