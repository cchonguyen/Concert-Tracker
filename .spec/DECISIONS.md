# Architecture Decision Records (ADRs)

- **ADR-001 (2026-10-26):** Adopted the claude-harness-hub v2.0 harness (hooks, subagents, `.spec/` state). Engine files are copied unchanged from the hub so `/sync-harness` can update them; project rules stay in AGENTS.md and take precedence over the harness rules. `.spec/` files link to REQUIREMENTS.md and ARCHITECTURE.md rather than duplicating them. Rejected: replacing CLAUDE.md with the hub template (would drop the pointers to the project rules); copying the hub's `.spec/` files verbatim (they describe the hub, not this app).
