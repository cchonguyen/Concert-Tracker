# Auto-verify acts and editions, and member ticks

Status: decisions recorded 2026-11-18; slices approved 2026-11-18 and built (slices 2 to 5 merged, PRs #543, #544, #546, #549, #552, #557). AGENTS.md rules approved and added in this change. Scope confirmed by Charlie in thread "Scope auto-adding Who I Saw artists to lineup".

## Goal

A lineup act is verified in code when an external source has its name and date, and an edition is verified in code when its canonical facts are complete. Member ticks feed the same lineup as candidates. The owner still sees everything in Global Archive. Nothing is verified by a model's say-so.

## Decisions (Charlie, 2026-11-18)

| # | Question | Decision |
|---|---|---|
| 1 | Which sources can verify? | Any external source that has the act's name and date verified. Recorded below as a rule, with two limits (see Conflicts). |
| 2 | Act or edition? | An act is auto-verified with its parameters. An edition is auto-verified when name, act, location, venue and date are all filled. |
| 3 | Threshold | One trusted source is enough. Two independent sources add confidence and are shown as such. |
| 4 | Member tick | Yes: it enters the lineup as a candidate, sourced "your entry". |
| 5 | Undo and demotion | Agreed: each auto-verify is logged in `edition_changes` with a system actor and reason, and can be undone. No automatic demotion. |
| 6 | Timing | Agreed: only in the lookup stage, never on save. A quota error parks the job and does not retry with another model. |

## Rule impact

These rules change, so AGENTS.md and ARCHITECTURE.md change first, in the same PR.

- **Shared-edition verification (AGENTS.md).** Today an edition becomes `verified` by the owner's tap, a verified ticket email, or a canonical ingest. Add: an edition also becomes `verified` in code when its name, act, location, venue and date are all filled from verified sources. The owner's tap stays available and is still logged.
- **Act status.** A shared act carries a status: `candidate` or `verified`. Members see verified acts only of a verified edition. Owners see both.
- **Source rule (AGENTS.md, "every stored act").** A member's own tick is stored with source type `your entry`, the typed text as the quoted span, and no user id in the shared row. Its audit record lives in `edition_changes` (owner only).
- **Sources that verify.** Anything in `docs/architecture/08-sources.md` that returns a name and date for an act counts, as long as the terms in that document allow storing what is needed (see Conflicts).

## Conflicts (decided by Charlie, 2026-11-18: all three yes)

1. **Brave Search.** Brave may point to a page. The app fetches and stores that page, and the verified fact comes from the stored page. Brave's own result is never stored in shared data, per `docs/archive/brave-rung3-spec.md`.
2. **setlist.fm.** Its terms bar keeping copies and putting data in shared storage. Reading: setlist.fm is checked live in code and stores only a source ID, a link and the verified flag. The stored name and date come from a fetched page or a ticket email, so setlist.fm alone cannot write an act's name or date into a shared edition. This follows `docs/ingest-canon-plan.md` rule C6.
3. **Gemini search.** Not a source. The reader may read a fetched page, and its quote counts only if the name occurs verbatim in it.

## Overlap with prior planned work (checked 2026-11-18)

- **Edition-lineup-from-name spec (`docs/archive/edition-lineup-from-name-spec.md`).** Its member proposals (Changes queue, `lineup_proposal`) are superseded by member ticks as candidates, as Charlie said ("no double confirmation"). Its owner tap, undo branch and catalog matcher still apply. Its slice 4 is retired when slice 2 starts.
- **Ingest plan (`docs/ingest-canon-plan.md`, approved).** `upsertOccurrence` already promotes provisional to verified on a ticket email, and rule 3 already makes ticket emails a verified source. Auto-verify of complete editions extends that rule. The owner's "Verify for everyone" (slices 12.4 and 12.5) stays as the manual path for incomplete editions.
- **Confidence (`AGENTS.md`).** Confidence is computed in code (`src/server/lineup/merge.ts`). The threshold must reuse that path, not add a second scheme.
- **Migration.** Act status needs a column on `performances`, because its current status holds only billed, performed or cancelled. The next free number is 0052, since 0051 exists.
- **Global Archive (`docs/archive/global-archive-rework-spec.md`).** Slice 4 extends Editions & Lineups; it does not replace it.

## Verification rules (in code, no model call)

- An act is `verified` when at least one trusted source has it for the same edition: a ticket email, a promoter or lineup page the app fetched, or an API that has the name and date (MusicBrainz, setlist.fm id only). Two independent fetched sources agreeing also verify it, and the act shows "2 sources".
- A `your entry` tick is `candidate`. A second member's tick for the same act counts as a second source only once a fetched source agrees. Two ticks alone do not verify.
- An edition is `verified` in code when name, act, location, venue and date are all filled and every fact comes from a verified source. A provisional edition with a missing field stays provisional.
- A location filled by the venue fill (`system:venue-location`, `docs/specs/venue-location-fill.md`) counts as a location from a verified source (Charlie, 2026-11-24): `locationVerifiedBy` in `src/server/canon/autoVerify.ts`.
- Auto-verify never overwrites a value the owner typed. It fills empty fields and changes status only.
- No demotion. A later disagreeing source adds a candidate note for the owner to review.

## Data and writes

- Every change goes through `writeEdition` (`src/server/canon/editions.ts`) with actor `system:<source>` or `member:entry`, and a reason.
- Undo: a new branch in `undoEditionChange` removes an auto-added act if unchanged, and reverts an auto-status change. A second undo is refused.
- Shared rows never hold a user id or any personal field (companions, notes, rating, price, attendance).
- Migration: `0052` adds an act status column on `performances` (`candidate` or `verified`). Written, held until Charlie says applied.

## Surfaces

- **Global Archive.** Editions & Lineups shows candidate and verified acts per edition, with source counts, and an "auto-verified" label on changes in the record.
- **Member view.** Verified acts of a verified edition autofill, as today. Candidate acts from a member's own tick show only on that member's event, labelled "your entry".

## Timing

Runs only in stage 2 (the lookup), never in save. Quota errors park the job.

## Slices (proposed; each under 5 files, through the harness slice gate)

1. **Rule text.** AGENTS.md and ARCHITECTURE.md rule changes above, plus the three conflict decisions recorded. Docs only.
2. **Act status and verification function.** Pure function in `src/server/canon/` for act and edition verification from sources. Tests for one source, two sources, missing fields, no-demotion, owner value kept. Core.
3. **Auto-verify writes and undo.** Wire into the lookup and the member-tick path through `writeEdition`; undo branch; tests. Core.
4. **Global Archive display.** Status and source counts in Editions & Lineups. UI, typecheck only.
5. **Member tick as candidate.** Route and Who I Saw hook, with no personal fields in the shared row. Core.

## Tests

- Verification: one trusted source, two agreeing sources, a single member tick (not verified), missing field (edition not verified), owner-typed value never overwritten, no demotion.
- Writes: auto-verify logs a change with the system actor; undo removes it; a second undo is refused; a member tick carries no personal field.

## Risks

- A wrong verified act reaches every member. The mitigation is the trusted-source list and undo.
- Source terms: setlist.fm and Brave limit storage. Conflicts 1 and 2 must be settled before slice 2.
- Edition auto-verify removes the owner's gate for complete editions. Undo and the change log are the only safety net.
