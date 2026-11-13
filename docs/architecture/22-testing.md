# Testing

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


`npm test` runs the node test suite in `tests/`: capture parsing, stage 1 research and its rules (`events.test.ts`), Check details, then "Read with Gemini" (`detailsGemini.test.ts`, which uses a fake reader instead of a live model; other tests build theirs with `guardedFromGemini` over a fake client), billing roles, type and name suggestions (`roles.test.ts`), page roles, title parts, format, gaps and bulk lookups (`gaps.test.ts`), set times, favourite set and weather (`extras.test.ts`), series and set type and B2B marks (`series.test.ts`), email readers, the year rule, grouping and the import routes (`email.test.ts`), list import reading, matching and merging (`listImport.test.ts`), artist genres from music-story and MusicBrainz (`genres.test.ts`), Google Sheets cells, edits and routes (`sheets.test.ts`), verbatim checks, merging and scoring, each adapter against recorded responses, quota parsing, and the full pipeline including quota parking, review learning and the cache. `npm run lint` typechecks. Add a test with every new adapter or rule.
