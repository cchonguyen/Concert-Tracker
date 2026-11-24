# Streamlining plan

Status: approved by Charlie 2026-11-24 (he chose "Wire it in" for auto-verify, and "delete the scripts" for slice 5). Built 2026-11-24: PRs #636, #639, #641, #643, #649, #652 and the tidy-up PR. Review doc: the "LiveArchive: redundancy and streamlining review" Claude Doc.

## Goal

Remove code that does the same job twice, fix the bug the review found, and switch on auto-verify, without losing any feature.

## Findings this plan acts on

1. `autoVerifyAct` and `autoVerifyEdition` (`src/server/canon/editions.ts`) are built and tested but never called, so ticks stay candidates and editions never verify on their own.
2. `normalizeActName` kept only a to z and 0 to 9, so any two all-non-Latin names matched each other.
3. Four name normalizers for one job (`lineup/normalizeName.ts`, `canon/autoVerify.ts`, `services/listImport.ts`, `events/regions.ts`).
4. Stage 1 (`events/details.ts`) and stage 2 (`lineup/adapters/`, `lineup/search.ts`) each have their own Ticketmaster, setlist.fm, Clashfinder and Brave Search client. Clashfinder's event list is fetched in 3 places.
5. Four date readers (`events/parse.ts`, `events/email/dates.ts`, `events/email/forwarded.ts`, `services/listImport.ts`) and month names written out in 8 files.
6. Small leftovers: unused helpers, one-off scripts, two unused packages, one browser pop-up instead of the shared Confirm, docs that describe the same tickets twice.

## Kept on purpose

- The file store and the Supabase store: the file store runs local development and the tests.
- `server.ts` and the Worker: both run the same Express app.
- Splitting the largest screens: ticket REF-02, its own work.
- `events/regions.ts` keeps its own region-name rule: its lookup keys are plain Latin words.

## Slices

1. One shared name normalizer; non-Latin names no longer match each other; an empty name never verifies. `[CORE / DATA]`
2. Wire auto-verify in where evidence arrives (`docs/auto-verify-spec.md`): every automatic change goes through `writeEdition` with a system actor and a reason, and can be undone. `[CORE / DATA]`
3. One client per source, shared by Check details and Find the lineup; Clashfinder's list fetched once per run. Stage logic stays separate. `[CORE / DATA]`
4. Shared month table and date reading; email keeps its own year rule. `[CORE / DATA]`
5. Tidy-up: unused helpers and packages, the Confirm dialog, duplicated docs. Deleting the one-off scripts waits for Charlie's yes. `[UI / VISUAL]`

Each slice passes `npm run lint` and `npm test` and merges when green.
