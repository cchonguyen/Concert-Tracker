# Rules for anyone changing this app

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing lineup lookup, storage or review. These rules apply to people and AI coding agents alike (Claude, Gemini in AI Studio, Copilot, and others). If a change conflicts with them, change the architecture document first and say why.

- Never synthesize, default or infer a lineup, date, venue, stage, rating or setlist. Missing data stays missing and the UI says so.
- Every stored act must reference a stored source document and a quoted span from it.
- Gemini may only extract from text the app fetched. It never answers from memory and is never asked for confidence, dates it was not shown, or URLs.
- Reject any extracted name that is not found verbatim (after normalization) in its source text. Do not loosen `isVerbatim`.
- Confidence is computed in code from sources and review history.
- On a quota error, park the job and stop. Do not retry with another model and do not fall back to heuristics or regex parsing.
- Do not add hardcoded lists of festivals, venues or artists. Improve an adapter or add a new one under `src/server/lineup/adapters/`.
- Respect source limits through the shared rate-limited fetcher (MusicBrainz 1 request/second). Do not scrape AXS.
- Keep the canonical lineup and the personal attendance log separate.
- Run `npm run lint` and `npm test` before committing, and add tests for new adapters or rules.
- Update ARCHITECTURE.md in the same change when behavior described there changes.
