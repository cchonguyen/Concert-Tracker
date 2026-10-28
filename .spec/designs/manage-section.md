# Manage section: artists, people, venues, places

Proposal v2, 2026-10-27, with Charlie's answers of 2026-10-28. Nothing here is built yet. v1 treated every name as text on each event; v2 gives every artist, person, venue, place, series, organization and label its own record with a permanent ID, and events point at those records.

## What changed from v1, and why

| Your call | What it changes |
|---|---|
| Venues always carry their location | A venue with a known city, state and country fills those on every event at that venue, everywhere, with no confirmation step. |
| Venue lookup is a separate requirement | Out of scope here. You type a venue's address and city yourself for now. Listed as R-later below. |
| Venues get AKA, always show today's name | No "name on the night" tracking. Old names are AKA, used only for matching. |
| Adaptive people names | Full name, then "First L.", then initials, depending on the space. |
| Stable IDs | Yes. This is the core of v2 (see "Data model"). |
| No genres or music-story yet | Removed from scope until that data is checked. |
| Consistency across dozens of entries | Shared attributes per category, picked from a list, plus a Data health view that catches drift. |

## Data model: stable IDs

**The problem with text.** Today a venue is the text "LA Historic Park" copied onto each event. Renaming it means rewriting every event, and every copy is a chance to drift ("LA Historic Park", "LA State Historic Park"). Typed columns per attribute make it worse: each new attribute would be a migration.

**Proposal:**

- **`entities`**: one row per thing. `id uuid` (permanent, never reused), `kind` (artist, person, venue, place, series, organization, label), `name`, `attrs jsonb`, `created_at`, `updated_at`. The kind's attribute list is defined in code (one schema per kind, validated on save), so **adding an attribute needs no migration**.
- **`entity_aliases`**: `entity_id`, `alias_normalized`. AKA names, old spellings and merged-away names. Used to match what you type, CSV rows, sheet rows, ticket emails and lineup results to the right record. The existing `artist_aliases` table folds into it.
- **`entity_links`**: `from_id`, `to_id`, `role`. Relationships between records: venue *in* place, series *hosted by* organization, venue/series *has label* Outdoor, person *introduced me to* artist.
- **Events point at records**: `logged_events.venue_id`, `series_id`, `place_id`; people and artists by ID inside the existing lists (`companions` becomes person IDs; each seen act carries `artist_id` next to the name and billing it already has).
- **`entity_history`**: every rename, merge and attribute change with the old value, so each one can be undone.

**Why this stays light as it grows:**

- A rename is **one row update**. No event is touched, so there is nothing to keep in step.
- A merge moves links from one ID to another and keeps the old name as AKA. It's a small, reversible update.
- New attributes are just new keys in `attrs`, defined in code.
- Indexes go on `kind`, `alias_normalized` and the event's link columns. At personal-archive scale (thousands of events, not millions) this is comfortably fast.

**Migration plan (0014), done safely:**

1. Create the tables. Build records from the distinct names already in your events, grouping names that match after normalization. Grouping that is less certain becomes a Data health "possible duplicate" offer, not an automatic merge.
2. Fill the new ID columns. **Keep the old text columns** for one release, written alongside the IDs, so nothing breaks and a rollback is just "stop reading IDs".
3. Once it has run cleanly, a later migration drops the old text columns.

**Where it gets tricky (hidden complexity):**

- **Sheet sync and CSV** show names, not IDs, and are written from the app only (settled 2026-10-28), so a rename simply shows up there on the next write. "Import a list" resolves names through AKA when adding new events.
- **Ticket emails and capture** still produce text. They resolve to an existing record by AKA, or create a new one. A new spelling never silently merges into an existing record.
- **Canonical lineups stay separate.** `artist_id` links your seen act to an artist record. The stored lineup and its quoted source text are not rewritten.
- **REQUIREMENTS.md and ARCHITECTURE.md** need updating in the same change: venue fills location (below), and the Table stops being the home for spelling clean-up.

## Venues and places

- A **venue** has: name, AKA, address, a link to its **place** (city, which knows its state and country), indoor/outdoor and other labels, capacity and type in your words, notes.
- When an event's venue has a place, the event's city, state and country **come from the venue**, always. Shown everywhere (Table, Map, Stats, event detail) without asking.
- An event whose typed city disagrees with its venue's place goes on a Data health list once, at migration time, so you can fix whichever is wrong. After that the venue wins.
- An event with a venue that has no place, or no venue at all, keeps its own city, state and country as today.
- **Rule change:** this is a relationship you entered, not a guess, so it fits "Never guess". REQUIREMENTS.md R1.9 gets a line saying a venue's place fills the event's location.
- **R-later, venue lookup (separate requirement):** find a venue's address and place from a source, as an offer with its link. Not part of this work.

## People and display names

- Stored: **First name**, **Last name** (optional), **Note**.
- Shown: the longest form that fits the space. **Full name** ("Mike Rivera") → **First + last initial** ("Mike R.") → **Initials** ("MR"). This uses the element's real width (CSS container queries), so it adapts on phone, table cells and chips.
- **Hidden complexity:** two people can share initials or "First L." ("Mike R." and "Mike Reyes"). When a shorter form would collide with someone else in your list, the display stays one step longer for both. Hovering or long-pressing always shows the full name.

## Shared attributes and labels (keeping dozens of entries consistent)

1. **Labels are records too** (kind `label`), picked from a list rather than typed. "Outdoor" exists once, so it can't drift into "outdoors" or "Open air". Renaming or merging a label works like any other record.
2. **Category attributes.** Once a label group like Indoor/Outdoor is used on one venue, it becomes a field for every venue. Venues without it show as gaps, and the entry view offers it ("Set indoor or outdoor").
3. **Linked suggestions.** If a festival series is Outdoor and its venue has no indoor/outdoor value, the venue gets a one-tap offer, and the other way round. Offers only; you choose.
4. **Data health view** in Manage, the drift catcher:
   - Possible duplicates (same after normalization, or one is an AKA of the other).
   - Missing attributes per category ("12 venues have no place").
   - Conflicts (an event's city vs its venue's place).
   - Labels used only once (often a typo).

   Each row is one tap from fixing.

## The Manage tab (unchanged from v1, apart from the categories)

- Category chips with counts: Artists, People, Venues, Places, Series, Organizations, Labels, and Data health.
- A list per category with search and sort. The entry view shows its events, attributes, AKA, links, history, and the actions Rename, Merge into…, and Show in Table.
- **Artists tab stays as insights.** Each card links to its Manage entry, and the entry links back. Venue, place and person names elsewhere link to their entries too.
- The Series panel moves in as the Series category.

## Ideas, ranked

Genres and music-story are left out for now.

### Do first: easy now, high value
| Idea | Why it's easy | Value |
|---|---|---|
| Venue AKA | Comes free with `entity_aliases` | Stops duplicate venues at capture |
| Data health / completeness meter | Counts over records | The fix for drift |
| Indoor / outdoor (as a label) | Label system above | Pairs with stored weather |
| Gap since last seen, longest wait (artists) | Computed from dates | Fun, zero risk |
| First show together, artists only seen with a person | Computed from links | High personal value |
| Introduced me to (person → artist) | One link role | Cheap and personal |
| Editions-attended streak (series) | Computed | Cheap |
| Custom tags ("bucket list") | Same as labels | Flexible |
| Change history | Already part of the model (`entity_history`) | Safety net for bulk edits |

### Do next: moderate effort
| Idea | The catch |
|---|---|
| Home city + distance, miles traveled, farthest trip | Needs coordinates per place. City-level points already come from Open-Meteo, but bare names can pick the wrong town, so only places you confirmed count. |
| Organizations and spend per organization or venue | Easy to build, but ticket price is sparse, so figures must say "based on N of M events". |
| Crew view (who comes together) | Simple to compute. Showing it well takes some design. |
| B2B partners network | Data exists (B2B marks). A network chart is UI work. |

### Hidden complexity or risk
| Idea | Risk |
|---|---|
| Discovery story (support → headliner) | Billing is stored only with a quoting source, so most seen acts have no role. The story would be thin and might mislead. Worth it only with a clear "role known for N sets" note. |
| Artist home city (MusicBrainz) | Rate-limited (1/sec), needs a resolved MBID, and MusicBrainz "area" is often a country only. Coverage will be patchy. |
| Lineup source per series | Touches the stage-2 lookup pipeline, which has strict rules. Better as its own change. |
| Timezone per city | Needs reliable coordinates first. Low value until set times are common. |
| Venue lookup (address from a source) | Already split out as R-later. Accuracy unknown. |
| Capacity / open-closed status from a source | Same sourcing problem. Fine when you type it yourself. |

## Build steps

1. **Records and IDs (migration 0014)**: tables, backfill from current names, dual-write, Data health "possible duplicates" from the backfill. Sheet sync becomes one-way (app to sheet); list import resolves names through AKA.
2. **Manage tab**: lists, entry view, rename, merge, AKA, history and undo; links from the Artists tab and elsewhere; Series panel moves in.
3. **Venues and places**: venue → place link, events take location from their venue, conflict list.
4. **People**: first and last name, note, adaptive display names.
5. **Labels and Data health**: label records, category attributes, linked suggestions, completeness and conflict lists.
6. **"Do first" insights** from the ranked list.
7. Later: drop old text columns; "Do next" ideas; venue lookup as its own requirement.

## Settled 2026-10-28

1. **Backfill conflicts:** a venue whose events disagree on city keeps its place empty. Data health asks you once per venue, offering the cities its events use, and sets it only when you pick one.
2. **Organizations** ship in the Manage step, right after Series, with "Hosted by".
3. **Sheets and CSV are outputs.** The app is the only source of truth. Sheet sync becomes one-way (app writes the sheet; edits made in the sheet are not read back) and CSV is export. "Import a list" stays only as a way to add new events and fill empty fields through its review, never to change what the app already holds. This removes the sheet-to-app half of today's sync, and with it the three-way-merge risk noted above.
