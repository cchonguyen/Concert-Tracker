# Learning loops

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


Review is where the system improves (`src/server/lineup/learning.ts`). Nothing retrains a model; every decision becomes data the next lookup reads.

| Your action | What is stored | Effect on the next lookup |
| --- | --- | --- |
| Rename an act | `artist_aliases`: old spelling to your spelling, plus a `renamed` correction | Variants merge in code, no AI call |
| Reject as "not an act" | `extraction_blocklist` per site, plus a `rejected` correction | After 2 rejections on a site, that string is dropped before review |
| Reject as "wrong event" | `rejected` correction, source penalized | Source reliability drops |
| Reject as "cancelled" | Performance kept with status `cancelled` | Sources are not penalized for billing it |
| Accept | `source_stats` accepted count per source, per series and globally | Reliability rises; confidence uses measured accuracy (Beta prior, weight 10) |
| Add a missed act | `added` correction | Shows which sources miss acts |
| Confirm a Gemini-read page | `extraction_examples`: an excerpt plus the confirmed names, up to 3 per site | The next read of that site includes a worked example |
| Confirm with a lineup URL, or with an accepted promoter page | `event_series.lineup_url` | Next year's lookup knows where to look |

Cached editions are not counted again in source stats. Every claim records its extractor and version (`gemini:<model>` plus `extract@5`; every page, the event's own site included, is told to keep only acts billed for that event and year and leave out other events, dates, cities and editions it lists), so claims from a bad model or prompt version can be found and re-checked later from the stored documents.
