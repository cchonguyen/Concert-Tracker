---
trigger: always_on
---

# PR & Harness Gate Workflow

- **Auto-PR on Verified Changes:** Once code changes pass `npm run typecheck --silent`, `npm run lint --silent`, and `npm test --silent`, automatically create a feature branch (if on `main`), commit, push, and open a PR (`gh pr create`) without waiting to be asked.
- **Anchor & Commit via `finish-slice.mjs`:** Before committing a PR's changes, ensure an `[IN_PROGRESS]` slice covering the target paths is committed in `HEAD:.spec/PROGRESS.md`, then commit via `node .harness/scripts/finish-slice.mjs "<msg>"` so `HEAD` carries `Referee-Verdict: VERIFIED` and `Referee-Tree` trailers.
- **Protect `AGENTS.md` in Feature PRs:** Never mix `AGENTS.md` edits into a feature PR (it triggers a Red tripwire in `pr-scope-check.mjs --strict`).
- **Pre-Push Gate Check:** Before running `git push`, verify `node .harness/scripts/ci-gate.mjs pr origin/main HEAD` and `node .harness/scripts/pr-scope-check.mjs origin/main HEAD --strict` both pass locally.
