# Session Handoff

- **Last Active Platform:** Google Antigravity
- **Active Branch / State:** `antigravity/multi-favourite-sets`
- **Branch Owner:** Antigravity / Charlie Cho Nguyen
- **Active slice:** B2B and Solo Performance Architecture & Multiple Favourites
- **Files Modified in Last Turn:**
  - `src/server/events/types.ts`: Added `id?: string`, `slotId?: string` to `SeenAct`.
  - `src/server/lineup/types.ts`: Added `slotId?: string`, `b2b?: string[]` to `EditionPerformance` and `CandidatePerformer`.
  - `src/server/lineup/actName.ts`: Updated `B2B` regex to handle multi-B2Bs (`A b2b B b2b C`), `vs`, `vs.`, and variants.
  - `src/server/lineup/merge.ts`: Group claims by performance slot (`artistKey::solo` vs `artistKey::b2b::slotSignature`), avoiding collapsing solo and B2B claims into one.
  - `src/server/lineup/learning.ts`: Preserved `b2b`, `slotId`, and instance `id` in `toPerformance`, `confirmLookup`, `confirmLookupForMember`, `dedupe`, and `mergeSeen`.
  - `src/server/lineup/pipeline.ts`: Preserved `b2b` and `slotId` in `candidateFromEdition`.
  - `src/server/events/seen.ts`: Refactored `seenSlots`, `withB2b`, `b2bGroups`, and `toSeenInput` to support multiple performance instances per artist. Exported `lineupSlots`.
  - `src/server/events/service.ts`: Preserved `id` and `slotId` in `cleanSeen` without collapsing distinct performances.
  - `src/services/reviewRows.ts`: Grouped candidate review slots using `groupReviewSlots`.
  - `src/components/LineupReview.tsx`: Rendered B2B slots as unified review rows with synchronized "Saw it" and "Keep" actions.
  - `src/components/EventDetail.tsx`: Rendered B2B lineup pills as unified `[Artist A b2b Artist B]` pills and disambiguated act selection in "Who you saw".
  - `src/services/stats.ts`: Counted viewings linearly for each instance in `e.seen` while unique artists remains distinct keys.
  - `src/services/artists.ts`: Tracked `sets: number` and unique `events` in `artistSummaries`.
  - `tests/mergeB2bSolo.test.ts`, `tests/seenSlots.test.ts`, `tests/reviewRows.test.ts`, `tests/actName.test.ts`: Added test coverage for B2B and solo performances.
  - `REQUIREMENTS.md` & `ARCHITECTURE.md`: Documented B2B and solo performance architecture (R3.10).
- **Verification Status:** All 648 unit tests pass, `npm run lint` clean (0 errors).

