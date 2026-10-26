See [REQUIREMENTS.md](REQUIREMENTS.md), [AGENTS.md](AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md). REQUIREMENTS.md says what the app is for and the principles behind it; ARCHITECTURE.md says how it works; AGENTS.md lists the rules.

@AGENTS.md

## Harness

This project uses the Token-Optimized Claude Code Harness (version in `.harness-version`, synced from the private `claude-harness-hub` repo). Project state lives in `.spec/` (start with `.spec/SESSION_HANDOFF.md`); the engine lives in `.claude/` and `.harness/` and is overwritten by `/sync-harness`, so put project-specific rules here or in AGENTS.md, not in `.claude/harness-rules.md`.

@.claude/harness-rules.md

When the harness rules and AGENTS.md disagree, AGENTS.md wins. In particular, `[UI / VISUAL]` slices still run `npm run lint` and `npm test` before committing.

## Project-Specific Commands
- Typecheck: `npm run lint --silent` (runs `tsc` for the app and the worker; there is no separate typecheck script)
- Unit Tests: `npm test --silent` (Node's built-in test runner over `tests/*.test.ts`, not vitest)
- Lint: `npm run lint --silent`
