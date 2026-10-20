# Rules for anyone changing this app

Read [REQUIREMENTS.md](REQUIREMENTS.md) first: it says what the app is for (remembering which events you went to and who you saw) and ranks the principles that settle trade-offs. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing capture, lineup lookup, storage or review. These rules apply to people and AI coding agents alike (Claude, Gemini in AI Studio, Copilot, and others). If a change conflicts with them, change REQUIREMENTS.md or ARCHITECTURE.md first and say why.

- Never synthesize, default or infer a lineup, date, venue, stage, rating or setlist. Missing data stays missing and the UI says so.
- Every stored act must reference a stored source document and a quoted span from it.
- Gemini may only extract from text the app fetched. It never answers from memory and is never asked for confidence, dates it was not shown, or URLs.
- Reject any extracted name that is not found verbatim (after normalization) in its source text. Do not loosen `isVerbatim`.
- Confidence is computed in code from sources and review history.
- On a quota error, park the job and stop. Do not retry with another model and do not fall back to heuristics or regex parsing.
- Do not add hardcoded lists of festivals, venues or artists. Improve an adapter or add a new one under `src/server/lineup/adapters/`.
- Respect source limits through the shared rate-limited fetcher (MusicBrainz 1 request/second). Do not scrape AXS.
- Keep the canonical lineup and the personal event log (`logged_events`) separate.
- Ticket emails are read by per-seller code under `src/server/events/email/`, never by Gemini. An imported show becomes an event only when you tick it, and never fills personal fields.
- Capture is two stages. Saving an event (stage 1) never waits on research, quota or a lineup; the lineup lookup (stage 2) only starts when asked for on a saved event.
- Stage 1 research uses structured APIs and web search results read in code, never Gemini. Its results are candidates: they never overwrite a field you typed, and fill empty fields on their own only when they match the full date you gave.
- Parse the capture line in code (`src/server/events/parse.ts`); text it cannot place stays in the name. Never add a model call to parsing.
- Keep capture to one line of text. New personal fields go on the event detail, not on capture.
- No demo or seeded data in the app.
- Run `npm run lint` and `npm test` before committing, and add tests for new adapters or rules.
- Update ARCHITECTURE.md (and REQUIREMENTS.md, if a requirement changes) in the same change when behavior described there changes.
