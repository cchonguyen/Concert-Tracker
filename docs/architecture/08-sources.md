# Sources

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


Each source is an adapter in `src/server/lineup/adapters/` implementing `SourceAdapter.collect()`. An adapter returns stored documents, performer claims, fact claims and documents that need extraction. Adapters that are not configured are skipped and reported in the job log.

| Adapter | What it gives | Access | Evidence |
| --- | --- | --- | --- |
| `clashfinder` | Acts per edition with stage, day and set times; past years stay archived | Free account. Every call is signed with `authUsername` + `authPublicKey` (SHA-256 of username, private key and parameters) | `crowd` |
| `promoter` | Official lineup page text (Insomniac, Goldenvoice, ...); for past editions the Wayback Machine snapshot closest to the event dates | Public pages; no key | `billed` (after extraction by the reader model) |
| `ticketmaster` | Canonical name, dates, venue and attractions for upcoming or recent events | Free Discovery API key, 5,000 calls/day | `billed` |
| `setlistfm` | Post-show setlists that upgrade an act to "performed" | Free non-commercial key | `performed` |
| MusicBrainz (`musicbrainz.ts`) | Stable artist IDs, resolved in the background after you confirm; artist genres only when you ask (Artist genres) | No key, 1 request/second | n/a |
| Web search (`search.ts`) | Stage 2: candidate lineup URLs when every source came back empty (stage 1 date checks are in `events/details.ts`): Brave Search API when `BRAVE_SEARCH_API_KEY` is set, otherwise grounded search through the reader model (today Gemini; needs a billed Gemini project) | Brave free plan, or the reader model's quota | Pages are fetched and extracted like any other; snippets are never evidence |

AXS is deliberately excluded as a lineup source: it has no public discovery API, and scraping it breaks its terms. Your own AXS ticket emails are read like any other seller's (stage 1 from email); nothing is fetched from AXS.

Clashfinder's event list is keyed by slug; the readable title is `desc` and `startDate` is Unix seconds. One edition often has several slugs (`edc2026`, `edclv2026`, a livestream clash), so the adapter takes the most-edited public clash whose title contains every word of the event name (or whose slug starts with them) and whose start date is in the year. Generic festival stop-words (`music`, `festival`, `arts`, `annual`) and compound phrases ("Music and Arts") are stripped during title comparison so queries like "Portola Music Festival" match "Portola 2023". When the event specifies a weekend or start date, date proximity (within ±2 days) adds a large score bonus (+500,000) and conflicting weekend declarations are rejected, disambiguating multi-weekend festivals (e.g. Coachella W1 vs W2). Private clashes and fantasy or predicted lineups are skipped because they are guesses.

Promoters overwrite their lineup page for the next edition, so a past event never reads the live page unless you gave that URL yourself and no snapshot exists. The Clashfinder hash format could not be verified when the adapter was written; it is configurable through `CLASHFINDER_HASH_FORMAT`, and `CLASHFINDER_PUBLIC_KEY` accepts a ready-made key.

Job logs and errors are shown in the UI and stored, so credentials are redacted from them (`redactSecrets` and `redactUrl` in `http.ts`).

All HTTP goes through `createRateLimitedFetcher()` (`src/server/lineup/http.ts`), which spaces requests per host (MusicBrainz 1.5 s with retry/backoff on 503, Clashfinder 1 s, setlist.fm 0.6 s, Open-Meteo 0.2 s) and sends a User-Agent with `CONTACT_EMAIL`.
