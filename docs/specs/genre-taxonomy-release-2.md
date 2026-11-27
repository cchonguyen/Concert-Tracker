# Genre taxonomy, Release 2: Lineup DNA and Event Match

Planned 2026-11-27, after Release 1 ([genre-taxonomy-release-1.md](genre-taxonomy-release-1.md)) merged. It follows Charlie's brief "Genre Taxonomy, Visualizations & Relational Discovery" and his decisions for this release: every act on a bill counts 1.0, stage bars show where the lineup has stages, and Event Match needs 20 sets over 5 events. Slices are 41.x. There is no migration and no new table.

## In plain English

- **Lineup DNA** is a short bar on an event's page that shows what the whole bill sounds like. It uses the 3 or 4 biggest scene families, and everything else goes under "Other". Tap a family to see the genres and acts inside it. When the lineup has stages, each stage gets its own bar. When fewer than 60% of the acts have a genre, a note under the bar says so, for example "7 of 15 acts have a genre."
- **Event Match** sits next to the bar. It compares the bill with what you usually see live and says it in words, for example "Strong fit for your Melodic House and Tech House history: 5 acts in your lane, 3 nearby acts you haven't seen." The acts it names are marked on the lineup.
- **Nearby genres**: Event Match counts a genre next to one you like as a partial match. It uses only the owner's "adjacent" links (curated and computed), one step out and never two. It also tones down genres that are linked to almost everything, so those don't swamp the score.
- **Floors**: Lineup DNA needs at least 3 acts with a genre on a bar. Event Match needs at least 20 sets with a genre across at least 5 of your events. Below a floor, the screen says what is missing in plain words.
- **Privacy**: a member already sees an event's full lineup, so they now also get the shared genres of every act on it, including acts they did not mark as seen. Their own added genres still show only on their screens. Nothing reads anyone else's events.

## Decisions this spec carries

1. Lineup DNA: every act on the lineup counts 1.0, split across its genres by weight, the same as Release 1 decision 1 (Charlie, 2026-11-27). The bill's own B2B pairs share one set, using `setShares`. Acts the lineup lists as `billed` and `performed` both count. Rejected or hidden performers do not.
2. Stage bars only where the lineup's performers carry `stages`. An act on two stages counts on each stage's bar. An act with no stage goes under "No stage listed", and that bar shows only when at least one other stage exists (Charlie, 2026-11-27).
3. Event Match floor: 20 sets with a genre over 5 events, the person's own, not counting this event (Charlie, 2026-11-27).
4. Smoothing follows the brief: one step only, `v_smooth = v + α · (Â · v)`, with α = 0.5 (the middle of the brief's 0.35 to 0.65). `Â` is the `adjacent` links read in both directions, each weight divided by `sqrt(deg(source) · deg(target))`, where `deg` is the sum of a genre's adjacent weights. That is the brief's hub dampening (norm^0.5). `secondary_parent` and `derived_from` links are not used here.
5. Proposed here: the Lineup DNA floor is 3 acts with a genre per bar. The 10-set chart floor from Release 1 suits a person's whole history, and a club night with 4 acts would never reach it.
6. Proposed here: a member is sent shared genre rows for every act on the lineup of an event they logged. See section 1. This reads AGENTS.md's "acts in their own events or records" as including the lineup the app shows them on their own event, so AGENTS.md is not changed. If Charlie prefers explicit wording, slice 41.0 adds one sentence to that rule (an AGENTS.md change, so it needs his tap).
7. Proposed here: the score is a cosine of the two family vectors, after smoothing on the genre level. The bands are "Strong fit" at 0.6 or more, "Some overlap" from 0.3, and "Outside your usual" below 0.3. A test pins each band with a small fixture, so the cut-offs can move later without reworking the maths.
8. Relations never change the Lineup DNA bar itself, only the Event Match score and the "nearby" list.

## 1. Lineup genres for one event (Slice 41.1)

- New read-only route `GET /api/events/:id/lineup-genres` in `src/server/events/genreRoutes.ts`. It works only for the caller's own event (the same `load` check as `/events/:id`; another person's id gives 404).
- It returns `{ acts, genres }`. `acts` lists the event's lineup as the event page already shows it (from `eventPerformers(event, job, edition)`): key, name, stages, days, status and the B2B slot. `genres` holds the shared `artist_genres` rows for those keys, plus the caller's own `added` rows for them.
- An event with no lineup returns empty lists. No lookup, fetch or model call is made, and nothing is written.
- Tests: owner and member get rows for unseen lineup acts; a member never gets rows for an act that is not on their own event; another member's `added` rows never appear; a foreign event id gives 404.

## 2. Lineup DNA maths (Slice 41.2)

`lineupDna(acts, byArtist, vocab)` in `src/services/genreInsights.ts` returns:

- `bars`: one for the whole bill and, when stages exist, one per stage (decision 2). Each bar has `segments` (the 3 or 4 largest families by weight; a fifth family shows only when it is at least 10% of the bar; the rest is "Other"), each `{ key, name, share, genres: [{ name, share }], acts: [key] }`.
- `tagged`, `total` and `coverage` (tagged over total) per bar; `lowCoverage` when coverage is under 0.6; `enough` when `tagged >= 3`.
- Without a taxonomy (sample mode before the tree is uploaded), the bar uses the music-story groups, as Release 1 does.
- Tests: weights add up to 1 per bar; a B2B pair shares one set; an act on two stages counts on both stage bars and once on the whole bill; "Other" collects the tail; coverage and floor flags.

## 3. Lineup DNA screen (Slice 41.3)

- New `src/components/LineupDna.tsx`, shown in `EventDetail.tsx` above the lineup table when the event has a lineup.
- One horizontal bar per entry in `bars`, using the same family colours as Sound Drift and the River legend. Tapping a segment opens a small panel with its top genres and acts (the shared `Popover`). Escape closes it.
- Under a bar with low coverage: "N of M acts have a genre." Under the floor: "Lineup DNA shows once 3 acts on the bill have a genre. N do."
- A visually hidden table carries the same numbers for screen readers.

## 4. Event Match maths (Slice 41.4)

`eventMatch(eventId, events, byArtist, lineup, vocab)` in `genreInsights.ts`:

- Your vector: every seen set at your other events, with `setShares`, split by genre weight. This event is left out, so a show you went to is scored against what you saw before and after it.
- Smoothing (decision 4) on the genre level, then summed up to families through `primary_parent_key`. The bill's vector is Lineup DNA's whole-bill vector, not smoothed.
- `score` (cosine), `band` (decision 7), and `lane`: the 1 or 2 families that add the most to the score, named in the copy.
- `inLane`: acts on the bill whose top genre is one of your own genres (before smoothing). `nearby`: acts whose top genre reaches you only through an adjacent link, split into `nearbyUnseen` (you never marked them as seen anywhere) and the rest.
- `enough`: 20 or more sets with a genre over 5 or more events (decision 3). Also needs Lineup DNA's `enough`.
- Tests: the one-step smoothing on a three-genre chain (A to B to C gives C nothing from A); hub dampening lowers a genre linked to many; the event itself is excluded; each band; floors.

## 5. Event Match screen (Slice 41.5)

- In `LineupDna.tsx`, a line under the whole-bill bar: "{Band} for your {lane} history: N acts in your lane, M nearby acts you haven't seen." Parts with a count of 0 are left out. "Outside your usual" says so without a lane.
- The lineup table (`LineupTable.tsx`) marks `inLane` acts with a small "Your lane" pill and `nearbyUnseen` acts with "Nearby", using the shared `Pill`.
- Under the floor: "Event Match needs 20 sets with a genre over 5 events. You have N sets over M events."
- Sample mode shows both, from the sample data, as Release 1 does.

## 6. Docs (Slice 41.6)

`docs/architecture/07-artist-genres.md` (event page section and the new route), `ARCHITECTURE.md` (event detail line), and the API list in `docs/architecture/` where routes are listed.

## 7. Slices

| Slice | Tag | What | Target files |
|---|---|---|---|
| 41.0 | CORE / DATA | Only if Charlie asks: one sentence in AGENTS.md's genre rule | `AGENTS.md` |
| 41.1 | CORE / DATA | Lineup genres route | `src/server/events/genreRoutes.ts`, `src/services/lineupApi.ts`, `tests/lineupGenresRoute.test.ts` (new) |
| 41.2 | CORE / DATA | Lineup DNA maths | `src/services/genreInsights.ts`, `tests/genreInsights.test.ts` |
| 41.3 | UI / VISUAL | Lineup DNA bar on the event page | `src/components/LineupDna.tsx`, `src/components/EventDetail.tsx` |
| 41.4 | CORE / DATA | Event Match maths and smoothing | `src/services/genreInsights.ts`, `tests/genreInsights.test.ts` |
| 41.5 | UI / VISUAL | Event Match line and lineup marks | `src/components/LineupDna.tsx`, `src/components/LineupTable.tsx` |
| 41.6 | UI / VISUAL | Docs | `docs/architecture/07-artist-genres.md`, `ARCHITECTURE.md` |

No slice adds a migration or writes to a shared table. Only 41.0 touches AGENTS.md, and only with Charlie's tap.

## 8. Not in Release 2

Genre orbits and the co-occurrence job (Release 3), festival-wide DNA across editions, Event Match on events you have not logged, and the artist page's Sonic DNA (parked).
