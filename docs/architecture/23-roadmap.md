# Roadmap

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


- Stage 2 strategies per kind of event: for single-artist shows, openers from the venue's or promoter's event page and setlist.fm on that date; for festivals, today's pipeline.
- Ideas ranked in REQUIREMENTS.md section 13 (artist pages, back-fill mode, setlists, share card).
- A weekly refresh job for editions that are upcoming or ended in the last 14 days, to pick up cancellations and additions.
- A regression command that re-runs extraction over stored documents and compares against confirmed lineups when the model or prompt changes.
- In the Table view: bulk edit of personal fields, merging spellings of venues, cities and companions, and sheet sync. Each writes through the existing event routes; none changes capture or lookup.
- Ticket type offered from your emails (per-seller readers under `src/server/events/email/`), as a one-tap offer on the event.
- Per-series source priority editing in the UI (`event_series.source_priority` is already read by the merge step).
