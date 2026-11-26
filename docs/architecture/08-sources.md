# Sources

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


Each source is an adapter in `src/server/lineup/adapters/` implementing `SourceAdapter.collect()`. An adapter returns stored documents, performer claims, fact claims and documents that need extraction. Adapters that are not configured are skipped and reported in the job log.

| Adapter | What it gives | Access | Evidence |
| --- | --- | --- | --- |
| `clashfinder` | Acts per edition with stage, day and set times; past years stay archived | Free account. Every call is signed with `authUsername` + `authPublicKey` (SHA-256 of username, private key and parameters) | `crowd` |
| `promoter` | Official lineup page text (Insomniac, Goldenvoice, ...); for past editions the Wayback Machine snapshot closest to the event dates | Public pages; no key | `billed` (after extraction by the reader model) |
| `ticketmaster` | Canonical name, dates, venue and attractions for upcoming or recent events | Free Discovery API key, 5,000 calls/day | `billed` |
| `setlistfm` | Post-show setlists that upgrade an act to "performed" | Free non-commercial key | `performed` |
| `pasted` | Acts and set times from a set-times page the owner copied into the app with its link (for sites whose terms forbid automated access, such as Festival Dust). Read in code by `parsePastedSets` (`pasted.ts`): a name line followed by a time line; dates come from the event, never from the paste; a stage only from a heading directly before its acts | None: the app never requests the link. Owner only | `crowd`; a trusted source for auto-verify |
| MusicBrainz (`musicbrainz.ts`) | Stable artist IDs, resolved in the background after you confirm; artist genres only when you ask (Artist genres) | No key, 1 request/second | n/a |
| Web search (`search.ts`) | Stage 2: candidate lineup URLs when every source came back empty (stage 1 date checks are in `events/details.ts`): Brave Search API when `BRAVE_SEARCH_API_KEY` is set, otherwise grounded search through the reader model (today Gemini; needs a billed Gemini project) | Brave free plan, or the reader model's quota | Pages are fetched and extracted like any other; snippets are never evidence Every Brave call (stage 1 and stage 2) goes through `braveCapFetcher` (`events/braveBudget.ts`): 200 queries a month by UTC month, then a 429 that parks the job; never cached, never written to shared editions. |

AXS is deliberately excluded as a lineup source: it has no public discovery API, and scraping it breaks its terms. Your own AXS ticket emails are read like any other seller's (stage 1 from email); nothing is fetched from AXS.

Clashfinder's event list is keyed by slug; the readable title is `desc` and `startDate` is Unix seconds. One edition often has several slugs (`edc2026`, `edclv2026`, a livestream clash), so the adapter takes the most recently edited public clash (`lastEdit` or `modified` in the list, compared as written; edit count only breaks ties after that) whose title contains every word of the event name (or whose slug starts with them) and whose start date is in the year. Generic festival stop-words (`music`, `festival`, `arts`, `annual`) and compound phrases ("Music and Arts") are stripped during title comparison so queries like "Portola Music Festival" match "Portola 2023". When the event specifies a weekend or start date, date proximity (within ±2 days) adds a large score bonus (+500,000) and conflicting weekend declarations are rejected, disambiguating multi-weekend festivals (e.g. Coachella W1 vs W2). Private clashes and fantasy or predicted lineups are skipped because they are guesses.

Promoters overwrite their lineup page for the next edition, so a past event never reads the live page unless you gave that URL yourself and no snapshot exists. The Clashfinder hash format could not be verified when the adapter was written; it is configurable through `CLASHFINDER_HASH_FORMAT`, and `CLASHFINDER_PUBLIC_KEY` accepts a ready-made key.

Job logs and errors are shown in the UI and stored, so credentials are redacted from them (`redactSecrets` and `redactUrl` in `http.ts`).

All HTTP goes through `createRateLimitedFetcher()` (`src/server/lineup/http.ts`), which spaces requests per host (MusicBrainz 1.5 s with retry/backoff on 503, Clashfinder 1 s, setlist.fm 0.6 s, Open-Meteo 0.2 s) and sends a User-Agent with `CONTACT_EMAIL`. The fetcher refuses axs.com and its subdomains, and any redirect that lands on them, so no path can fetch AXS.

## Source terms: what may be stored

Read on 2026-11-13 from the official pages named below. Quotes are short extracts. Where a term could not be found the entry says so: treat that as not allowed to persist beyond what the terms clearly permit. This section is a reading of the terms by an AI agent, not legal advice; the persistence rows at the end are a recommendation for Charlie to confirm.

### Ticketmaster Discovery API

Terms: https://developer.ticketmaster.com/support/terms-of-use/ and https://developer.ticketmaster.com/products-and-docs/apis/getting-started/ (read 2026-11-13). The Partner API Terms of Use and General Terms of Use linked from those pages were not read.

- What may be stored and for how long: the terms forbid you to "Cache or store any Event Content other than for reasonable periods in order to provide the service you are providing." "Reasonable periods" is not defined. Permanent copies of event content are not clearly permitted.
- Removal: on request you must "Remove from your application within 24 hours any Event Content". The app must be able to delete Ticketmaster-derived content on that notice.
- Caching limits: see above; short caching only.
- Attribution or link-back: not found on the terms page. The rate-limit increase criteria mention compliance with "our branding guide" (design.ticketmaster.com), which was not read. Treat attribution as not found.
- Rate limits: default quota of "5000 API calls per day" and "5 requests per second". Ticketmaster also "reserve[s] the right to rate limit or block applications that make a large number of calls".
- Commercial or personal use: the licence is "non-exclusive, non-sublicenseable, non-transferable" and "All rights not expressly granted to you are reserved by Ticketmaster." A personal-use rule was not found.

### setlist.fm API

Terms: https://www.setlist.fm/help/terms (read 2026-11-13).

- What may be stored and for how long: you may not "Retain any copies of the Setlist.fm data, except for the purposes of retaining cached information for short periods." You also may not store setlist.fm user data "in any data repository which enables any third party access", and "You must make direct server calls to the API for the Setlist.fm data". Permanent storage of setlist data is not permitted.
- Caching limits: "short periods" only; the length is not defined.
- Attribution or link-back: required. "you must display attribution on your website or client application wherever Setlist.fm data is used", "you must use the attribution link each API response contains", and link to the homepage of the site. The terms also forbid tagging links with nofollow.
- Rate limits: "We reserve the right to limit the rate at which calls may be made to the API". Transactional pages must not be hit "more than once during any three-second interval" and the API must not put "an unreasonable or disproportionately large load" on the site. The adapter's 0.6 s spacing is a code setting, not a figure from the terms.
- Commercial or personal use: "You are permitted to use the API solely for non-commercial purposes". "If the primary purpose of your application is to derive revenue, it is considered commercial." Competing products or services are forbidden. The API key must not be shared with any third party. setlist.fm may "implement a fee and payment terms for use of the API at any time" and may change or discontinue the API at any time.
- Presentation: data must be provided to users "on an as is basis".

### Clashfinder API

Terms: https://clashfinder.com/pages/api/ (read 2026-11-13, by direct fetch; the page is the API manual). A search of clashfinder.com for terms of use found no terms page; /pages/terms, /pages/about and /pages/privacy returned 404, and the site footer links only to the API page and a cookies page (https://clashfinder.com/pages/cookies/, not read).

- What may be stored and for how long: not found, treat as not allowed to persist beyond what the terms clearly permit.
- Caching limits: not found.
- Attribution or link-back: not found.
- Rate limits: not found. The only access rule is that every call must carry `authUsername` and `authPublicKey` (an account is required; "API calls now require authentication"). The 1 s spacing in the fetcher is our own choice.
- Commercial or personal use: not found. No licence for the data was found; the data is user-entered, so the contributors' rights are also unknown.
- Note: Clashfinder offers free account-based API access, but access is not a licence to store or redistribute.

### Recommendation: what Slices 11.14 and 11.16 may persist

Recommendation only; Charlie to confirm before either slice is built.

| Source | Slice 11.14 (backfill into shared editions) and Slice 11.16 (persist dated occurrences) may persist |
| --- | --- |
| Ticketmaster | Store: our own record of the Ticketmaster event id and URL (as a pointer), plus facts the person confirmed (date, venue name, city) as our own event fields with a link back. Do not store: the full API payload, images, descriptions or other "Event Content" as a durable copy. Re-fetch on demand, short-lived cache only, and delete Ticketmaster-derived content within 24 hours of a removal request. |
| setlist.fm | Store: the setlist.fm setlist id and the attribution link as a pointer only. Do not store: setlist song lists or user data as a durable copy, and never in any shared or third-party-readable store (this matters for shared editions). Fetch directly at read time, short cache only, show attribution wherever shown. Personal, non-commercial use only. |
| Clashfinder | Store: the clashfinder slug as a pointer, the acts an owner reviews and confirms from a Global Editions "Find lineup" run (festival editions only; never automatic), and only the minimum our adapter already keeps as a source document with a quoted span. Do not store: bulk copies of a clash (all acts, stages and times) into shared editions, because no storage permission was found. Ask the Clashfinder operator for permission before persisting more. |

Member entry (Slice 11.23): `persistOwnEntry` in `src/server/events/details.ts` runs inside the research queue message after the catalog lookup. It upserts a `provisional` shared edition from the event's own typed name, full date, venue and city through `upsertOccurrence` (actor `member:entry`; at most 8 extra store calls). It writes nothing for a year-only event or when a verified edition matched, and never personal fields.

Event detail readout: `EventSources` (`src/components/EventSources.tsx`) renders the "Where every detail came from" card as the last card of the event detail, full width below both columns, with Check details and Deep search in it, listing one entry per distinct source (grouped by URL, plus the shared edition or venue record) with `SourceIcon`, what fields or act/set-time counts it gave, its quote in serif italic, and an outbound link; hovering or focusing a field's `via …` / `from …` link highlights the matching entry.
