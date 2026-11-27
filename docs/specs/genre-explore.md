# Genres in Explore

Status: ideas and mockups approved by Charlie on 26 Nov 2026 (Pacific). Not started. This spec waits for his OK on the Explore tab changes (section 3) before the slices in section 9 start. Planned for Gemini to build.

Mockups: https://claude.ai/artifact/GHxso4yoYwvpzsUT4nHG5u (sample data, made-up acts). The ideas doc with research: https://claude.ai/artifact/BNbgw1XSULuC6An3RbHSAp.

## 1. The idea in one paragraph

Genres are now shared and fairly complete (`docs/specs/canonical-genres.md`, `docs/specs/genre-vocabulary.md`). This spec turns them into small stories about the person: which genres they see most and the artists behind them, what they've got into lately, their firsts and milestones, how their taste moved over the years, and who they go with for which genre. Everything is worked out in the browser from the person's own events. No new table, migration, route or model call is needed.

## 2. Decisions (Charlie, 26 Nov 2026)

1. All ideas are preferred except "compared with the archive's lineups" (idea 12), which is parked.
2. A member's own added genres (`user_artist_genres`, source `added`) count in that member's own stats, and only theirs. This already happens: `genresByArtist` appends them for the member, and the owner never receives them.
3. "Lately" means the last 12 months against the 12 months before them.
4. Playful labels are wanted (section 6, idea 10).
5. Genres by who you went with is wanted (idea 7).
6. Explore already has seven tabs, so no new tab. Existing tabs are combined and extended instead (section 3).

## 3. Explore, reconfigured

Today the Explore strip has seven tabs: Agenda, Month, Heatmap, River, Map, Stats, Ranking. After this work it has four, and the genre features live inside them.

| Tab | Today | After |
| --- | --- | --- |
| **Timeline** | Agenda, Month, Heatmap and River are four separate tabs | One tab. A `Segmented` switch at the top picks Agenda, Month, Heatmap or River. River gains "Colour by genre" (idea 5b). |
| **Map** | Every city | Adds a genre picker that lights up matching pins (idea 8). |
| **Stats** | Totals, year in review, rankings, fun facts, "Genres you see live" | Adds a **Lately** card at the top (ideas 2 and 6), a genre row in Year in review (idea 4) and a **Your genre story** section: firsts and milestones, range and label, over the years, by kind of night and season (ideas 3, 10, 5, 11). "Genres you see live" shrinks to the top 3 genres with a "See all" link to Ranking, Genres. |
| **Ranking** | Everyone you've seen live | Gets a switch at the top: **Artists** (today's view), **Genres** (idea 1, with a List or Tree view for idea 9) and **People** (idea 7). |

Rules for the change:

- The `?view=` names stay as they are (`agenda`, `month`, `heatmap`, `river`, `map`, `stats`, `ranking`), so links and remembered subtabs keep working. The strip shows one Timeline tab, and that tab is marked as open for any of the four timeline views. Clicking it opens the timeline view this device opened last (`liveArchive.subtabs`), else Agenda.
- Ranking's switch is `?view=ranking&by=artists|genres|people`. A missing or unknown `by` means `artists`.
- Home keeps one card per strip tab, so it shows one Timeline card in place of four. Its live number is the count of shows.
- On a phone the strip still shows icons only, so Timeline uses the Agenda icon from `pageIcons.ts`.
- `docs/architecture/14-navigation-and-home.md` and `tests/nav.test.ts` change in the same slice.

## 4. Rules for every genre feature

These come from `AGENTS.md` and the genre specs. Breaking one is a bug.

- **Never guess a genre.** An act with no genre stays without one and is counted apart ("from 212 of 240 sets; the other 28 have no genre yet"). No model writes genres, labels or story lines. Every sentence is filled from numbers by code.
- **Only shows you went to.** Planned and "didn't go" events never count, except in "Coming up", which only reads planned events still ahead.
- **Show the count beside the share.** Write "31% · 66 sets", never a bare percentage.
- **Minimum sizes.** Each claim has a threshold (section 6). Below it the card says "Not enough shows yet" with the count so far, or the card is hidden where the section says so.
- **Your stats stay yours.** Everything is worked out in the browser from the events and genre rows the person already receives. Nothing new is sent to the server, written to a shared table, logged, or added to the owner's genres file. No feature compares one member with another.
- **Use the vocabulary.** Always call `genresByArtist(genres, vocabulary, map)` and count by `genreKey`, so spellings, aliases, merges, groups and umbrellas apply. A genre with no group counts under "Not grouped".
- **People stay private.** Companion names come from the vault in the browser (`src/services/vaultPeople.ts`). While the vault is locked (`peopleLocked`), people features show "Unlock your vault to see this" and nothing else. Companions never appear on a share card, the public share page or any shared table, matching `docs/specs/ticket-stub.md`.
- **Dates.** A month-only event counts in its month and year but is never placed on a day. "First" and "last" sort month-only events at the start of their month. Copy says "the first you logged", never "your first ever".
- **Two ways of counting, said plainly.**
  - **Share** (bars, rising, over the years, year in review) uses `genreMix` weighting: each set counts once, split across its act's genres by weight.
  - **Has the genre** (firsts, milestones, gone quiet, family tree, map) counts a whole set when the act has that genre at all.
  - Each card's helper text names which one it uses in plain words.
- **Look and parts.** Use the shared parts in `src/components/ui/` (`Segmented`, `Tabs`, `Pill`, `Popover`, `Tooltip`, `StubHeader`, `Switch`) and the Harness UI rules in `.harness/design-system/`. Match the mockups' layout and the app's tokens. Motion stops under reduced motion. Touch targets are at least 44 px on phones. Every chart has a text equivalent for screen readers.

## 5. Shared maths

Add one pure module, `src/services/genreInsights.ts`, with tests in `tests/genreInsights.test.ts`. Screens only render what it returns. It takes `events: LoggedEvent[]` (already filtered to went), `byArtist: Map<string, ArtistGenres>` from `genresByArtist`, the `vocabulary`, and `today` (YYYY-MM-DD) passed in, never read from the clock inside.

Functions, each with its own tests:

- `periodEvents(events, period, today)`: `all`, `last12` (the 365 days ending today), a year (`2026`). Used by the period picker.
- `artistsBehind(events, byArtist, vocab, genre)`: for a group, style or umbrella, the acts ranked by their weighted share of it. Each row has the act's key and name, its weighted sets in that genre, its whole set count, and the date last seen. Ties break by name.
- `rising(events, byArtist, vocab, today)` and `cooling(...)`: section 6, idea 2.
- `goneQuiet(...)`, `comingUp(plannedEvents, ...)`: idea 6.
- `genreFirsts(...)`, `genreMilestones(...)`, `newThisYear(...)`: idea 3.
- `genreRange(...)` and `genreLabel(...)`: idea 10.
- `genreByYear(...)` and `genreStoryLine(...)`: idea 5.
- `genreByKind(...)`, `genreBySeason(...)`: idea 11.
- `yearGenres(events, year, ...)`: idea 4.
- `peopleGenres(events, byArtist, vocab, people)`: idea 7. `people` maps a person id to a name, filled by the screen from the vault.
- `genreTree(vocab, events, byArtist)`: idea 9.

## 6. The features

Each block says where it lives, what the person sees (exact copy in quotes), the rule, and what shows when there isn't enough data. Mockup boards are named in brackets.

### Idea 1: Top genres, with the artists behind them (preferred) [Main]

- **Where:** Ranking, Genres. Stats keeps a three-row summary that links here.
- **Shows:** the title "Genres you see live" and the coverage line. A period picker reads "All time", "Last 12 months", the current year and "Pick a year". The **Genre** column lists groups, and the **Style** column lists styles with a "Include related genres" switch that adds umbrellas, as Stats does today. Each row shows its name, "31% · 66 sets" and a bar.
- **Tap a row** to open it in place: "The artists behind it", the top 5 acts from `artistsBehind`, each with "9 sets · Oct 2026" and a bar for their share of the genre. Under them is "See all 38 techno acts in Artists", which opens Ranking, Artists with today's genre filter set (`g:` for a group, `u:` for an umbrella; add a style filter if one doesn't exist).
- **Rule:** shares use `genreMix`. An act's share of a genre is the sum of its weights in that genre over its sets.
- **Empty:** with no genres at all, show "No genres yet. Genres appear once your acts have them." The owner also sees a link to Manage, Genres.

### Idea 2: On the rise (preferred) [Rising]

- **Where:** the Lately card at the top of Stats.
- **Shows:** "Lately you're into drum & bass." Under it: "9 sets across 5 events in the last 12 months, up from 2 the 12 months before. Rainmetre and Vesper Lane did most of it." Then up to 4 rising genres, each with two bars (the 12 months before, and the last 12 months) and "2 → 9". Under that, a "Cooling off" list of up to 2 genres, each with "14 → 3 sets".
- **Rule:** windows are the 365 days ending today and the 365 days before them. Compare styles and umbrellas by `genreKey`, using weighted sets. A genre is **rising** when it has at least 5 sets across at least 3 events in the last 12 months, and either its count at least doubled or its share went up by at least 10 points. Rank rising genres by the gain in sets. When an umbrella and a genre under it both qualify, show only the one lower down. A genre is **cooling** when it had at least 5 sets before and the last 12 months have half that or fewer. The headline uses the top rising genre, and "did most of it" names its top two acts from `artistsBehind` over the last 12 months.
- **Empty:** when nothing qualifies but there were sets lately: "No genre has really taken off in the last 12 months." Under 5 sets with genres in the last 12 months: "Not enough shows in the last 12 months to call a trend yet. You've logged 3 sets since December 2025."
- **Footnote:** "A genre shows here only with at least 5 sets across 3 events in the last 12 months."

### Idea 6: Gone quiet, and coming up (preferred) [Rising]

- **Where:** the Lately card, right column.
- **Gone quiet:** "You haven't seen a trance set since March 2025." Under it: "Your last one was Halcyon Drift at Dreamfields. You'd seen 30 before that." Then a link to Ranking, Artists filtered to that genre.
  - **Rule:** the genre has at least 5 sets all time (has-the-genre count), and the last one was at least 18 months ago. Pick the one with the most sets. At most one is shown.
- **Coming up:** up to 3 lines, "Your next techno set" with the act and venue under it ("Mira Vale at The Foundry"). When it's the first set in a genre that has gone quiet, add ", the first since March 2025".
  - **Rule:** only planned events still ahead. Use the acts already marked as seen on the planned event. When none are marked, use the acts on the lineup the event shows, and say "on the lineup". Never add anything to who you saw. First check during the slice whether planned events carry a lineup in the browser. If they don't, use marked acts only.
  - **Footnote:** "From events you planned. They never count in your totals until you went."
- **Empty:** each half hides on its own when it has nothing.

### Idea 3: Firsts and milestones (preferred) [Firsts]

- **Where:** Stats, Your genre story.
- **Firsts:** "How each genre found you" lists the first set you logged in each group, oldest first, as year, group, then "Act at Event, 14 Jun 2012". It uses the has-the-genre count. When several acts tie on the first event, name up to 2 alphabetically and add "and N more".
- **New to you in 2026:** pills for styles whose first set you logged falls in the current year. Hide when there are none.
- **Milestones:** tiles for the 10th, 25th, 50th, 100th and 250th set in a group, has-the-genre count. Show the latest 4 reached, each with the act, event and date. Also "10 years of house" when a group's first set was 10 or more years ago and it has a set in the last 12 months. Under them: "Next up: your 100th house set is 4 sets away", for the nearest milestone within 5 sets.
- **Empty:** hide the card under 10 sets with genres.

### Idea 10: Range and playful label (preferred) [Firsts]

- **Where:** Stats, Your genre story, beside milestones.
- **Shows:** "41 genres across 9 of 13 groups", a strip of 13 squares (lit for groups seen, in music-story's group order), and "Your top genre, techno, is 31% of your sets." When it's 1 to 4 groups, add "Not yet: jazz, rock, folk, classical."
- **Label:** one label at most, the first that matches in this order, with the rule shown in a `Tooltip` or `Popover` on tap. It needs at least 30 sets with genres, else no label.

| Label | Rule (all on weighted group shares, all time) | Line shown on tap |
| --- | --- | --- |
| **Shape-shifter** | The top group of the last 12 months (at least 10 sets) differs from the all-time top group | "Your top genre lately isn't your all-time top genre." |
| **Devoted** | The top group is 60% or more | "One genre is 60% or more of your sets." |
| **Double act** | The top two groups are 75% or more together, and each is 25% or more | "Two genres make up three quarters of your sets." |
| **Deep diver** | One style is 25% or more of all sets | "One style is a quarter of everything you see." |
| **Explorer** | 5 or more groups, none over 40% | "No genre is over 40%, across 5 or more groups." |
| **All-rounder** | Anything else | "A bit of everything." |

- The thresholds live as named constants at the top of `genreInsights.ts`, so they're easy to tune.

### Idea 5: Your genres over the years (preferred) [River]

- **Where:** Stats, Your genre story.
- **Shows:** a stacked area chart by group, one band per group, with x = year and y = share of that year's sets (weighted). It shows the top 5 groups and "Other". It is drawn in SVG with no new chart library, using the group colours from the mockup through tokens. Years with fewer than 10 sets with genres are faded, with their count on hover. Hovering or focusing a year shows "2021 · 24 sets" and its shares. A visually hidden table gives the same numbers.
- **Story line** (`genreStoryLine`): this needs at least 3 years with 10 or more sets.
  - When the top group changes and the new one stays on top for at least 2 years: "You moved from house to techno around 2021."
  - When one group led every counted year: "Techno has led every year since 2018."
  - Otherwise: "Your top genre changes from year to year."
- **Empty:** hide under 3 counted years.

### Idea 5b: River, coloured by genre (preferred)

- **Where:** Timeline, River.
- **Shows:** a "Colour by genre" switch. When it's on, each mark takes the colour of its event's top group (weighted), with a small legend. Events with no genres stay the plain colour. When it's off, River is unchanged. The switch is remembered per device (localStorage, errors ignored).

### Idea 11: By kind of night and by season (preferred) [River]

- **Where:** Stats, Your genre story.
- **Kind:** one stacked bar each for Concert and Festival (the kind worked out by `src/server/events/scale.ts`, or the person's own choice). There is also a bar for each `format` value the person typed that has 10 or more sets, such as "Club night". The headline comes from the top group of the two biggest bars, for example "Festivals are for house. Club nights are for techno." When they share a top group: "House leads at every kind of night."
- **Season:** four tiles named by months, "Dec–Feb", "Mar–May", "Jun–Aug" and "Sep–Nov", so no hemisphere is assumed. Each shows its top group and "38% of 52 sets". A tile under 10 sets says "Not enough yet" with "7 sets so far". The headline names the season where the top group's share is most above its all-time share: "Jun–Aug is when you go for trance." With no clear lead (under 5 points), there is no headline.
- **Rule:** a split shows only with at least 10 sets in it.

### Idea 4: Year in review, and a share card (preferred) [YearShare]

- **Where:** the Year in review block in Stats gets a genre row, and Library, Share, Event cards gets a "Year in genres" card.
- **Row** (`yearGenres`):
  - "Top genre": the style with the most weighted sets that year, with "33% · 19 sets · mostly Mira Vale".
  - "Newest to you": the first style first logged that year, with "First: Anvil North, 18 Apr".
  - "Genres explored": distinct styles that year, with "up from 17 in 2025".
  - "Biggest change from 2025": the style with the largest change in sets, in either direction, written as one sentence.
  - "Your favourite sets, by genre": "7 of your 12 favourite sets this year were techno", from `SeenAct.favourite`. It shows only with 3 or more favourites.
  - The row hides for a year with under 10 sets with genres.
- **Card:** drawn in the browser like today's event cards (`src/services/shareCard.ts`, `ShareCards.tsx`), shaped like the ticket stub. It shows "My year in genres", the top 5 styles each with one act and a share, and a footer of genres, sets and nights. The options are "Artists" and "Percentages", both on by default. There is no companion option: people never go on a card. Pick the year from years with 10 or more sets. "Save as image" downloads a PNG. Nothing is sent.

### Idea 7: Who you go with, by genre (preferred) [Later]

- **Where:** Ranking, People, and one more line in the person insights in Manage, People.
- **Shows:** people ranked by shows together, each with their top 2 groups as "Drum & bass 6 of 8 · Bass 4 of 6". That reads as 6 of the 8 drum & bass shows you went to with anyone had them there. The headline is one sentence for the strongest pair, for example "Drum & bass nights are with Sam." In the person insights: "Your genres together: drum & bass, bass".
- **Rule:** per show, not per set. A show counts for a group when any act you saw there has it. A person shows only with 3 or more shows together that have genres, and a group pairing only with 3 or more shows. "With Sam" in the headline needs over 50% of that group's shows with anyone.
- **Private:** names come only from the vault, and there's nothing while it's locked (section 4). Nothing about people leaves the browser.
- **Empty:** "Add who you went with on an event to see this."

### Idea 8: Genres on the map (preferred) [Later]

- **Where:** Map.
- **Shows:** a "Genre" picker of groups and umbrellas, using the same values as the Ranking filter. Pins with a set in that genre (has-the-genre) stay bright, others fade. The headline reads "Your techno city is Berlin." when one city has 3 or more of those events and the most of them; otherwise there is no headline. With nothing picked, Map is unchanged.

### Idea 9: Your genre family tree (preferred) [Later]

- **Where:** Ranking, Genres, with a "List | Tree" switch.
- **Shows:** each umbrella from the vocabulary as a tree, with child genres indented under it (nested umbrellas nest). Branches you've seen are lit and show their set count (has-the-genre). Unseen branches are dimmed and say "not yet". The title is "House: 5 of 7 branches seen".
- **Suggestions:** for an unseen branch, "afro house, 3 acts played at shows you went to". These are acts on the lineups of events you went to, but not marked as seen, that have that genre. They show as a link that opens those events and never adds anyone. First check during the slice whether the browser already gets lineups and those acts' genre rows. Members get genre rows only for acts in their own events or records (AGENTS.md). If the rows aren't there, ship the tree without suggestions and say so in the PR.
- **Empty:** the switch hides when the vocabulary has no umbrellas.

### Idea 12: Compared with the archive's lineups (parked)

Parked by Charlie on 26 Nov 2026 as "not that exciting right now". Not to be built. It would need a new server count across shared lineups and careful privacy design.

## 7. Files this touches

- New: `src/services/genreInsights.ts`, `tests/genreInsights.test.ts`, and components for the Ranking switch, Genres ranking, Lately card, genre story cards and year-in-genres card. Name them after the existing ones (`GenresRanking.tsx`, `LatelyCard.tsx`, `GenreStory.tsx`).
- Changed: `src/services/nav.ts`, `tests/nav.test.ts`, `src/App.tsx`, `src/components/HomePage.tsx`, `src/components/timeline/TimelineTab.tsx`, `src/components/timeline/RiverView.tsx`, `src/components/StatsView.tsx`, `src/components/ArtistsView.tsx`, `src/components/MapView.tsx`, `src/components/ManageEntry.tsx`, `src/components/ShareCards.tsx`, `src/services/shareCard.ts`, `src/services/insights.ts`.
- Docs: `docs/architecture/14-navigation-and-home.md`, `docs/architecture/07-artist-genres.md`, `ARCHITECTURE.md` (the genres line), `docs/README.md` (list this spec).
- No change to the server, the store, migrations, routes, `AGENTS.md` or `REQUIREMENTS.md`.

## 8. Tests that must exist

- `tests/genreInsights.test.ts` covers each threshold, both above and below it. That includes the 5-sets-across-3-events rising rule, the umbrella-and-child rule, cooling, gone quiet at exactly 18 months, month-only dates, ties, each label in order and the 30-set floor, the story line cases, season tiles under 10 sets, and favourites under 3.
- It also covers privacy: `peopleGenres` returns nothing for a person id that isn't in the map passed in, and the year card content carries no people.
- Planned and missed events never count. The test passes them in and expects them ignored, except by `comingUp`.
- A member's added genres count: a test builds `byArtist` with an `added` row and sees it in the shares.
- `tests/nav.test.ts` checks that the strip shows four tabs, that the Timeline tab is active for all four views, that each old `?view=` still opens its page, and that `by` falls back to `artists`.
- `tests/shareCard.test.ts` checks that the year card content has no companions or private fields.

## 9. Slices

Each slice is one pull request, at most 5 files apart from docs. Run `npm run lint --silent` and `npm test --silent` before each commit. UI slices need the typecheck only, plus a phone and a desktop screenshot in the PR. Issues are opened before each slice starts.

| Slice | What | Tag | Ideas |
| --- | --- | --- | --- |
| 37.1 | This spec, listed in `docs/README.md` and `.spec/PROGRESS.md` | docs | all |
| 37.2 | Explore strip: one Timeline tab with the view switch; Home card; nav docs and tests | CORE | section 3 |
| 37.3 | `genreInsights.ts` part 1: period, artists behind, rising, cooling, gone quiet, coming up | CORE | 1, 2, 6 |
| 37.4 | `genreInsights.ts` part 2: firsts, milestones, new this year, range, label, by year, story line, kind, season, year genres, people, tree | CORE | 3, 4, 5, 7, 9, 10, 11 |
| 37.5 | Ranking switch (Artists, Genres, People shell) and Genres ranking with artists behind; Stats card shrinks to top 3 | UI | 1 |
| 37.6 | Stats: Lately card | UI | 2, 6 |
| 37.7 | Stats: Your genre story, part 1 (firsts, milestones, range and label) | UI | 3, 10 |
| 37.8 | Stats: Your genre story, part 2 (over the years chart, kind and season) | UI | 5, 11 |
| 37.9 | Year in review genre row and the Year in genres share card | UI | 4 |
| 37.10 | Ranking, People, and the person insights line | UI | 7 |
| 37.11 | Map genre picker | UI | 8 |
| 37.12 | River colour by genre | UI | 5b |
| 37.13 | Genre family tree in Ranking, Genres | UI | 9 |

Order: 37.2 to 37.6 first (the reshaped tabs and the three ideas Charlie liked most), then 37.7 to 37.10, then 37.11 to 37.13.

## 10. Open checks for the builder

- Do planned events carry their lineup in the browser (idea 6)? Do lineup acts' genre rows reach a member (idea 9)? If not, build without that part and say so in the PR. Don't add a route for it without asking.
- Does Ranking, Artists already filter by a single style? If not, slice 37.5 adds a `s:` filter value next to `g:` and `u:`.
