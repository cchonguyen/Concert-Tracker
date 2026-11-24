# Edition lineup from the edition name

> **Archived 2026-11-23.** Slices 1, 2, 3 and 5 built (Slices 2.16, 2.19, 20.3). Member proposals (Slice 4) were replaced by member ticks in [auto-verify](../auto-verify-spec.md).

Status: draft for review (2026-11-17). Scope confirmed by Charlie in thread "Auto-add artist named in edition".

## Goal

When a shared edition's name starts with a catalog artist, offer that artist as a lineup act. Owner taps apply at once. Member taps become proposals the owner decides. Nothing is added without a tap. The owner's Global Archive and the member's Fill gaps both get a "Find gaps" list of these offers.

## Decisions (from Charlie, 2026-11-17)

| # | Question | Decision |
|---|---|---|
| 1 | What does a tap change? | The shared edition's lineup, for everyone. |
| 2 | Who writes? | Owner taps apply at once and are recorded in `edition_changes`. Member taps create a proposal in the Changes queue; the owner approves or rejects it. |
| 3 | Which artists count? | Catalog matches only (`canonical_artists`). Creating a new catalog artist is a later slice. |
| 4 | Which editions? | All editions: those with a lineup and those without. |

Open (Charlie to answer): false-positive test names. See "Matching" below.

## Rule impact

- AGENTS.md already allows one-tap offers from an event's name. An automatic add is not built, so no rule change is needed for the tap version.
- The source rule ("every stored act references a stored source document and a quoted span") needs a reading. Proposal: the edition's own name is the source document, with source type `edition name`, and the quoted span is the matched text. This is a rule interpretation. Slice 1 writes it into ARCHITECTURE.md and AGENTS.md, and Charlie confirms it in that PR.

## Matching (pure, in code, no model call)

File: `src/server/canon/nameArtists.ts` (new).

1. Normalize the edition name and each catalog artist name with `normalizeName` (`src/server/lineup/normalizeName.ts`).
2. A candidate is a catalog artist whose normalized name is a whole-word prefix of the normalized edition name. Whole words only: "future" does not match "futurebeats".
3. Take the longest candidate. If two candidates tie in length, offer nothing.
4. Guard: if the remainder after the prefix (the text after the artist) equals a known series, brand or venue name in the catalog, offer nothing. That data comes from the catalog, not a hardcoded list.
5. Connectives ("at", "presents", "with", "feat", ":", " - ") end the artist name. The remainder is not checked against the connective.
6. No fuzzy matching. No matching against personal entities or a member's seen acts.
7. An artist already in the lineup is not offered again.

Known false positives this rule still allows (for Charlie to confirm or reject): an artist whose name is also a festival's first word. Example: "Future Music Festival" matches the artist "Future" unless "Future Music Festival" is a series in the catalog. Charlie to supply three names he would reject.

## Data and writes

- Owner tap: `writeEdition` (`src/server/canon/editions.ts`) with the act appended to `performances`. Actor is the owner's id, reason `edition name`. The change record already notes `performanceCount`.
- Undo: `undoEditionChange` cannot undo a summary-only change ("summary-only changes cannot be rolled back as a field edit"). Adding an act needs its own undo branch that removes the act if it is still there and unchanged. Slice 2 adds that and a test.
- Member tap: a new review-queue kind `lineup_proposal`. The `review_queue.kind` check constraint (`supabase/migrations/0041_shared_occurrences.sql:110`) needs a migration, `0049_lineup_proposals.sql` (next free number after 0048). The migration is written, not applied. Migration PRs wait until Charlie says applied.
- Payload holds only the edition id, the matched name text, the artist key and the artist name. No user id and no personal field (the same rule as provisional editions in Slice 11.23).
- Approve writes through `writeEdition` as the owner, reason `member proposal`. Reject sets status `dismissed`.

## Surfaces

- Owner: Global Archive > Editions & Lineups gets a "Find gaps" list: every edition with a matching catalog act not yet in its lineup. One tap per row adds the act.
- Owner: Changes queue shows member proposals with approve and reject.
- Member: Fill gaps gets a `lineup` gap. For a linked event whose shared edition has a matching act, one tap proposes it. Member copy says the owner decides.
- Backfill: none. The list is the backfill. Nothing is written on save or on a timer.

## Slices

Each slice is under 5 files. All run through the harness slice gate.

1. **Matcher and rule text.** `src/server/canon/nameArtists.ts` plus tests with the Charlie examples: "Tsha at Sound Nightclub", "Above and Beyond Group Therapy", and the false-positive names once given. Also updates ARCHITECTURE.md and AGENTS.md (source reading). Core.
2. **Owner tap and undo.** Route `GET /api/manage/canonical/name-matches` (owner only, all editions), `POST` to add one act through `writeEdition`, and the undo branch in `editions.ts`. Core.
3. **Archive Find gaps.** New list in `CanonicalArchive.tsx`, using `src/components/ui/` components. UI, so typecheck only.
4. **Member proposals.** Migration `0049`, member route with no personal fields, owner approve and reject in the Changes queue. Core. Migration PR held until Charlie applies it.
5. **Member Fill gaps `lineup` gap.** `src/services/table.ts` and `FillGaps.tsx`. UI, typecheck only.

## Tests

- Matcher: exact prefix, longest match wins, ties offer nothing, whole-word boundary, series-remainder guard, already-in-lineup skip, no fuzzy match.
- Writes: owner tap records a change with source `edition name`; undo removes the act; a second undo is refused; a member proposal carries no personal field (checked the same way as `tests/editionChanges.test.ts`).

## Risks

- A false positive on a shared lineup is seen by every member. The owner list and the Changes queue are the only gates for members, and the owner tap is the gate for the owner.
- Member proposals can pile up. Show a count and allow dismiss.
- The migration is needed for member proposals. Until it is applied, slice 4 stays red and blocked.
