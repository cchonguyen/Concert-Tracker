# Context Atlas

The single entry point and registry for this repo's `.spec/` artifacts. Definition and rules: [docs/CONTEXT_ATLAS.md](../docs/CONTEXT_ATLAS.md).

## Sector 000 Card Catalog
- `000` [CLAUDE.md](../CLAUDE.md) — pointer to agent instructions
- `010` [AGENTS.md](../AGENTS.md) — rules for every agent
- `020` [docs/CONTEXT_ATLAS.md](../docs/CONTEXT_ATLAS.md) — Atlas definition & rules
- `050` [REQUIREMENTS.md](../REQUIREMENTS.md) — What the app is for and its principles
- `060` [ARCHITECTURE.md](../ARCHITECTURE.md) — How capture, lookup, storage and review work
- `070` [docs/README.md](../docs/README.md) — Index of feature specs, designs and backlogs

## Sector 100 Work Dispatch
- `110` [.spec/PROGRESS.md](PROGRESS.md) — Active slice queue & lock
- `120` [.spec/archive/HISTORY.md](archive/HISTORY.md) — Completed slice archive
- `130` `.spec/BLACK_BOX.md` — flight-recorder dump on 2-strike failure (only after a failure)
- `140` [.spec/SESSION_HANDOFF.md](SESSION_HANDOFF.md) — Session handoff state

## Sector 200 Boundaries
- `210` [.spec/boundaries/locks.md](boundaries/locks.md) — File lock invariants & boundaries
- `220` [.spec/boundaries/do-not-build.md](boundaries/do-not-build.md) — Out-of-scope list
- `230` [.spec/EXTERNAL_AGENT_RULES.md](EXTERNAL_AGENT_RULES.md) — Rules for external agents

## Sector 300 Contracts
- `305` [.harness/config/thresholds.json](../.harness/config/thresholds.json) — thresholds & line budgets
- `310` [.spec/contracts/referee.md](contracts/referee.md) — Neutral Referee arbiter & trailer contract
- `320` [.spec/contracts/circuit-breaker.md](contracts/circuit-breaker.md) — Circuit breakers & freeze protocol
- `330` [.spec/contracts/baton-pass.md](contracts/baton-pass.md) — Dual platform handoff contract
- `340` [.spec/contracts/review-relay.md](contracts/review-relay.md) — Review registry & PR scope gate

## Sector 400 System Spec
- `400` [.spec/SYSTEM_SPEC.md](SYSTEM_SPEC.md) — System specification & contracts
- `410` [.spec/DECISIONS.md](DECISIONS.md) — Architecture Decision Records
- `420` [.spec/OVERVIEW.md](OVERVIEW.md) — Project overview & build status
- `430` [.spec/AI_STUDIO_RULES.md](AI_STUDIO_RULES.md) — AI Studio rules alias
