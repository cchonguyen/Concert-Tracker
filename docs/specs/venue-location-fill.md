# Venue fills location (spec)

Status: proposed 2026-11-24, waiting for Charlie's approval. Thread: "Scope auto-filling venue location".

## Ask

When an edition or event has a venue whose location is already known, fill its city, state (region) and country
automatically, in the event Details screen and in Global Editions, and fill existing editions in bulk.

## Decisions (Charlie, 2026-11-24)

| # | Question | Answer |
|---|----------|--------|
| 1 | Fill blanks only, or also replace a different location? | Blanks only. A value already there is never replaced. |
| 2 | Same venue name known in more than one city? | Fill nothing. Show each known location as a one-tap choice. |
| 3 | Does a location filled from the venue count toward an edition becoming verified? | Yes, it counts as a verified location. |
| 4 | Fill existing editions in bulk? | Yes. |

## How it works today (2026-11-24, main at 3489cbf)

- Event Details (`src/components/EventDetail.tsx`, `cityForVenue`): picking a venue fills an empty city only, and only
  when every other event of yours at that venue used one city. State and country are not filled.
- A venue you placed in Manage (an `in` link to a place, `src/server/entities/venuePlace.ts`, `withVenuePlace`) already
  sets city, state and country on every event at that venue when it is saved.
- Global Editions (`EditionFactsForm` in `src/components/CanonicalArchive.tsx`): the venue fills nothing. City offers
  past cities and map guesses (`usePlaceAutofill`).
- Shared venue list (`canonical_venues`): the record id is name + city + state + country (`venueIdFor`). It is written
  once by the first edition that used it (`upsertVenue`, `ignoreDuplicates`) and never updated. `match.ts` and
  `backfill.ts` pass city and country but not state. A venue saved without a city is its own record with no location,
  so one venue can hold two records. `findVenueByAlias` returns a record only when exactly one holds the name.
- Edition auto-verify (`autoVerifyEdition`, `editionVerified` in `src/server/canon/`) exists and is tested, but no
  code calls it yet.

## The rule: a venue's known location

`venueLocation(venueName)` looks at every shared venue record that holds the venue's normalized name (its aliases) and
keeps the distinct non-empty locations (city, state, country, compared after normalization; a location that only
adds state or country to the same city is the same location).

- Exactly one location: that location is the answer.
- More than one: no answer. The choices are returned for one-tap offers.
- None: no answer, nothing offered.

Nothing is guessed: no map lookup, no model call, no hardcoded venue list. Only empty fields are filled. A field that
already has a value is left alone, even when it disagrees.

For your own events, the order is: the place you set for the venue in Manage, then the one location your other events
at that venue agree on, then the shared venue list.

## Behavior

1. **Event Details.** Picking or typing a venue fills any empty city, state and country from the venue's known
   location, saved at once like today's city fill, marked "from venue" (source `venue`). Several locations: nothing
   is filled and each is shown under City as a one-tap choice. A linked event still shows the edition's location
   unless you overrode it (`resolveEvent` is unchanged).
2. **Global Editions form.** Entering a venue fills empty City, State and Country in the form from the shared venue
   list, with a "from venue" note beside them. Several locations: one-tap choices. Saving still needs the source note
   and goes through `writeEdition` (logged, undoable).
3. **Shared venue list gets state.** New venue records keep the state they were saved with.
4. **Bulk fill.** An owner panel in Global Editions lists every edition with venue text and an empty city, state or
   country whose venue has exactly one known location: edition, venue, and what would be filled. "Fill all" writes
   each one through `writeEdition` with actor `system:venue-location` and reason "location from venue <name>", one
   logged change per edition, each undoable from Changes. Editions with several locations are listed separately with
   one-tap choices. It runs in batches inside the Worker's request budget and can be run again; an edition already
   filled is skipped.
5. **Verification.** A location filled from the venue (Details, form or bulk) counts as a location from a verified
   source when edition facts are built. This changes the AGENTS.md auto-verify rule, so the same slice updates
   AGENTS.md, `docs/auto-verify-spec.md` and the architecture. Edition auto-verify is not switched on anywhere yet;
   this slice only makes sure the location counts when it is.

## Rules kept

- Never guess: only a location already stored on a venue record or your own records is used.
- Blanks only: no field with a value is changed, by hand-triggered fill or bulk fill.
- Every shared edition change goes through `writeEdition`, is recorded and can be undone.
- Shared tables and logs get no personal fields. Your own Manage places and events fill only your own events, never a
  shared edition.
- No migration needed: `canonical_venues` already has a `region` column.

## Slices

Each slice is one pull request. Verify for all: `npm run lint --silent && npm test --silent`.

| Slice | Tag | What | Target files |
|-------|-----|------|--------------|
| 1 | CORE / DATA | `venueLocation` rule and a store read of every venue record holding a name | `src/server/canon/venueLocation.ts` (new), `src/server/lineup/store/types.ts`, `src/server/lineup/store/fileStore.ts`, `src/server/lineup/store/supabaseStore.ts`, `tests/venueLocation.test.ts` (new) |
| 2 | CORE / DATA | Read route `GET /api/venues/location?name=` (signed-in members; returns location or choices only) and venue records keep state | `src/server/canon/venueLocation.ts`, `src/server/canon/match.ts`, `src/server/canon/backfill.ts`, `src/server/entities/routes.ts`, `tests/venueLocation.test.ts` |
| 3 | UI / VISUAL | Global Editions form fills from the venue | `src/components/CanonicalArchive.tsx`, `src/services/lineupApi.ts` |
| 4 | CORE / DATA | Event Details fills city, state and country from the venue (Manage place, your events, shared list) | `src/components/EventDetail.tsx`, `src/services/venueLocation.ts` (new), `tests/venueLocationClient.test.ts` (new) |
| 5 | CORE / DATA | Bulk fill: preview and apply, owner only, batched, logged and undoable | `src/server/canon/venueFill.ts` (new), `src/server/canon/reviewRoutes.ts`, `tests/venueFill.test.ts` (new) |
| 6 | UI / VISUAL | Bulk fill panel in Global Editions | `src/components/VenueFillPanel.tsx` (new), `src/components/CanonicalArchive.tsx`, `src/services/lineupApi.ts` |
| 7 | CORE / DATA | A venue-filled location counts as verified; rule and docs | `src/server/canon/autoVerify.ts`, `tests/autoVerify.test.ts`, `AGENTS.md`, `docs/auto-verify-spec.md`, `docs/architecture/02-stage-1-capture-and-details.md` |

Exact file names may shift by one or two once a slice reads the code beside them; a slice that needs a new file says
so in its pull request.

## Risks

- The shared venue list's location came from whichever edition first used the venue, possibly a member's unchecked
  entry. With decision 3, a wrong venue location can help verify editions. Undo and the change log are the safety net.
- Old duplicate records (one with a city, one without) are handled by the rule: the empty one adds no location.
- Bulk fill on many editions is limited by the Worker request budget, so it may take more than one press.
