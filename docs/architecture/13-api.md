# API

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


| Method and path | Purpose |
| --- | --- |
| `GET /api/events` | Your events, newest first, plus a summary of each one's lineup lookup and the size of each confirmed lineup (`editions`) |
| `POST /api/events` | Save one typed line as an event (`{ text }`). With `editionId` (a confirmed canonical edition you tapped), the event is copied from that edition and linked to its lineup; 404 if the edition is missing or not confirmed. Runs no research |
| `GET /api/editions/suggest?q=` | Up to 5 confirmed editions whose name matches the typed words (`{ editions: EditionSuggestion[] }`, `q` under 2 letters gives `[]`), for the capture bar; editions already logged are left out |
| `GET /api/events/:id` | The event with its lineup job, confirmed edition and acts suggested from its name |
| `PATCH /api/events/:id`, `DELETE /api/events/:id` | Edit or delete an event |
| `POST /api/events/:id/details` | Run stage 1 research; `{ useGemini: true }` also has Gemini read the pages found (Check details, then "Read with Gemini") |
| `POST /api/events/:id/details/pick` | Pick a suggestion (`{ candidateId }`) or dismiss them (`{}`) |
| `POST /api/events/:id/lineup` | Start stage 2 for the event (`{ lineupUrl? }`) |
| `POST /api/events/lineups` | Queue stage 2 for up to 5 events per request (`{ ids }`; Fill gaps sends up to 50 in chunks); skips events with a confirmed lineup, a lookup that is not `failed`, or no date. Jobs are not kicked: the worker or the Cloudflare cron runs them one at a time |
| `GET /api/events/:id/name-artists` | Parts of the event's name that MusicBrainz knows as artists, as suggestions |
| `POST /api/events/name-artists` | The suggestions from `GET /api/events/:id` for up to 500 events (`{ ids }`), from stored data only (`storedNameSuggestions`); returns `{ suggestions: { [eventId]: [...] } }` |
| `POST /api/events/:id/weather` | Look up the weather on the event's days; returns `{ event, note? }`, with a note saying why when there is none |
| `POST /api/imports/email` | Read ticket emails into review rows (needs `IMPORT_TOKEN`); returns counts read, unreadable, ignored and changed |
| `GET /api/imports` | Review rows from your email, newest first |
| `POST /api/imports/add` | Add the ticked rows as events (`{ ids }`); rows already in your log are not added again, and rows still ahead are added as upcoming (`attendance: 'planned'`) |
| `POST /api/imports/merge` | Merge a row into an event you entered (`{ id, eventId }`): fills only the event's empty date, venue, city and price from the email and links the row; returns `{ event, import, filled, kept }` |
| `POST /api/imports/unmerge` | Undo a merge (`{ id }`): clears the fields it filled that still hold the email's value and puts the row back on the list |
| `POST /api/imports/skip` | Leave rows out: not attended or not a show (`{ ids }`), or put them back (`{ ids, restore: true }`) |
| `GET /api/imports/scan` | Check email: whether it is set up and Gmail connected, the account, and how far mail has been read |
| `POST /api/imports/scan` | Read the next few new ticket emails into review rows; returns counts read, remaining and added (409 when Gmail needs connecting) |
| `GET /api/gmail/connect`, `GET /api/gmail/callback` | Connect Gmail (Google sign-in, read-only); the callback also finishes the Google Sheets sign-in |
| `GET /api/sheets` | Google Sheets sync: whether it is set up and signed in, the account, and the linked sheet |
| `GET /api/sheets/connect` | Sign in to Google Sheets |
| `POST /api/sheets/link` | Link a sheet (`{ url }`) or make a new one (`{ create: true }`) |
| `POST /api/sheets/unlink`, `POST /api/sheets/disconnect` | Unlink the sheet, or sign out |
| `GET /api/sheets/values` | The linked tab's cells (unformatted), their `version`, and the rows last written there (`base`) |
| `PUT /api/sheets/values` | Replace the tab with `{ rows, version }` and keep the rows as the next base; 409 when the tab changed since that version |
| `GET /api/places/cities?q=` | City suggestions as `City, ST` (Open-Meteo geocoding, cached in memory) |
| `GET /api/places/guess?city=&region=&country=` | The state and country of a stored city when one place clearly fits (`placeGuess`): `{ guess: { city, region, country, label, places } \| null, note? }`. Never saved here |
| `GET /api/places/point?city=&country=` | Where a stored city is, for the map: `{ lat, lon, match }` where `match` is `exact` (the state or country you wrote matched) or `name` (the biggest place by that name); `null` when a state or country you wrote matches nothing (Open-Meteo geocoding, `cityPoint`, cached in memory) |
| `GET /api/artist-genres` | Stored artist genres, whether a genre map has been uploaded and every genre you can pick (`{ genres, hasMap, known }`) |
| `POST /api/artist-genres/music-story` | Upload music-story's `artist_genres.json` (up to 25 MB): keeps its genre map and the genres of acts you saw; returns `{ matched, seen, inFile, mapTags }` |
| `PUT /api/artist-genres/:key` | Your own genres for a seen act (`{ styles }`, up to 10, 60 characters each), or `{ reset: true }` to drop them; returns `{ row }` |
| `POST /api/artist-genres/musicbrainz` | MusicBrainz genres for up to 5 seen acts (`{ keys }`), read through the genre map; returns `{ genres }` (400 before a genre map is uploaded) |
| `GET /api/lineup/status` | Store kind, which sources are configured, the call quota and a `reader` block (omitted when no reader is configured). Everyone gets `provider`, `model`, `thinkingLevel`, `enabled`, `breaker` (`open`, `until`, `failures`), `callsToday` and `callsMonth`. The owner also gets `spendTodayUsd`, `spendMonthUsd`, `caps` (day and month dollars, calls per job, input chars, output tokens), `logWriteFailuresToday` and `recent` (the last 20 `ai_calls` rows, with no page text). There are no recall routes: recall is a local CLI that never runs in the app |
| `POST /api/lookups` | Start a lookup without an event (kept for scripts); returns the job (already `needs_review` on a cache hit) |
| `GET /api/lookups`, `GET /api/lookups/:id` | Job list and detail with log and candidate lineup |
| `GET /api/manage/canonical/lookups` | Owner only. Recent jobs with no saved event, newest first (the Global archive's Lookups list) |
| `GET /api/manage/canonical/editions/:id` | Owner only. One edition as a record: its facts, and its acts with billing, B2B, set, days, stages, set times and sources (`{ edition }`) |
| `PATCH /api/manage/canonical/editions/:id/facts` | Owner only. Edit name, `startDate`, `endDate`, `venue`, `city` with a required `sourceNote` (400 without one, 404 for no such edition). A blank fact is stored as null. Writes `event_editions` only (`{ edition }`) |
| `POST /api/manage/canonical/confirm` | Owner only. Merge an edition into the catalog. Without `apply: true` it returns the merge diff only (`{ applied: false, diff }`); with it, it writes (Edit lineup sends the preview first) |
| `PATCH /api/manage/canonical/artists/:key` | Owner only. Rename a catalog artist (`name`); its old name becomes an AKA |
| `POST /api/manage/canonical/artists/:key/merge` | Owner only. Merge this artist into `into` (an artist key); the target's MBID wins, else the source's |
| `POST /api/manage/canonical/artists/:key/aliases` | Owner only. Add an AKA (`name`) |
| `DELETE /api/manage/canonical/artists/:key/aliases?name=` | Owner only. Remove an AKA |
| `POST /api/lookups/:id/run` | Retry now |
| `POST /api/lookups/:id/confirm` | Save the reviewed lineup and learning data, and the event's seen acts |
| `GET /api/editions` | Confirmed and draft editions |
