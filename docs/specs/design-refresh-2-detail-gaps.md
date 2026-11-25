# Gemini package "Detail gaps": LiveArchive 2.0, stage 3

Status: approved by Charlie on 25 Nov 2026 (Pacific), as fixes 1 to 4 of the mockup review. Not started.

Stages 0 to 2 of the 2.0 refresh have merged (`docs/specs/design-refresh-2.md`, and the back-office brief). A review on 25 Nov compared the approved board "Round 3 · Dense event detail" with the live app. Most of the event detail matched. Four parts of it did not, and this package builds them:

1. The Lineup tab is a cloud of name chips. The board, and decision 8 in the spec ("Lineup stays a table"), call for a table. Its Day and Stage filters are about 22 px tall, so they also fail the touch-size rule.
2. There is no "Where every detail came from" section. Sources show only as small "via …" links beside fields.
3. The right-hand tabs are "Who you saw" and "Lineup". The board has Lineup, You saw and Changes.
4. The left column is a stack of always-open edit boxes. The board shows quiet read rows with icons, and you tap one to edit it.

Out of scope:
- The ticket stub. It is being discussed in its own thread, so do not touch `PosterHeader.tsx`. Also leave the "Did you go?" attendance box in `EventDetail.tsx` as it is: its look, its wording and its place at the top of the left column.
- The two missing poster chips ("Verified edition" and "5th edition you went to").
- Star ripple and the Stats callout.

The board itself is on the design canvas (https://claude.ai/artifact/2eTeWGL5SgNCHSAZMbY2eg, board "Round 3 · Dense event detail"). A copy of its source is at `/mnt/project-files/design-refresh/mockups/R3Detail.dc.html` for Claude. Gemini works from this brief, which spells out everything the board shows.

## Rules that still hold
- Everything in `AGENTS.md`. In particular, nothing is invented:
  - A missing stage reads "Not known yet".
  - A missing set time reads "No time".
  - An act with no billing quote reads "Artist".
  - An inferred role keeps its "Inferred" label (`docs/specs/inferred-values.md`).
- **Set times and stages come only from timed sources.** `EventDetail.tsx` already works them out per act (the `sets`, `chipTimes` and `starts` maps built from `actSets`). Reuse those maps and never compute new times.
- **Saving behaves exactly as today:**
  - a field saves when you leave it, or 500 ms after you stop typing
  - a stored value never replaces what you are typing
  - offers, inferred values and the green "Saved" flash all work as they do now
- **Visual rules:** sections 2 to 5 of `docs/specs/design-refresh-2.md`.
  - Tokens only. No hard-coded colours, and no white text on an accent.
  - Square tabs and tables. 12 px cards and 8 px controls.
  - Serif only for headings and source quotes. Mono for times, counts and dates.
- **Touch targets:** 44 px on phones, 36 px from 640 px up.
- **Reduced motion is honoured.** No state is shown by colour alone.
- **Shared parts:** use the ones in `src/components/ui/` (`Tabs`, `Ledger`, `Pill`, `KindPill`, `SourceIcon`, `Equalizer`, `IconButton`). Add a new shared part only where a slice below says so.

## Slices

All four slices change `src/components/EventDetail.tsx`, so they run in order. Each one starts from `main` after the previous one has merged.

### 28.1 Lineup as a table, with a square day picker [UI / VISUAL]
Target files: `src/components/LineupTable.tsx` (new), `src/components/EventDetail.tsx`, `docs/architecture/15-shared-ui.md`

1. **Move the lineup body into `LineupTable.tsx`.** That is everything inside `<section id="lineup">` after the progress block: the filters, the slot list, and the tick-to-add logic with its B2B handling. Pass in what it needs: `lineupActs`, `event.seen`, the `sets`/`starts` maps, `inferredBilling`, and an `onSeenChange(seen)` callback that calls `save({ seen })`. The tick logic moves unchanged.
2. **Render the slots as a table**, `<table>` with a sticky header. The columns are:

   | Column | What it shows |
   |---|---|
   | Saw | A checkbox-style tick. Its accessible name is "Seen: Name" or "Not seen: Name". |
   | Act | The name. A B2B slot shows its names joined by "b2b", plus a small mono B2B pill. |
   | Billed as | Headliner or Support from the act's billing quote. An inferred role keeps its "Inferred" label. Everything else is "Artist". |
   | Stage | From a timed source, or "Not known yet" in the faint tone. |
   | Set time | Mono "HH:MM–HH:MM" from a timed source, or "No time" in the faint tone. |

   - Seen rows get bold names and a 3 px accent edge bar on the left, which comes with the tick.
   - Headers are small mono caps.
   - Rows are square, 44 px tall on phones and 40 px from 640 px up.
   - On phones, hide the Stage column and show the start time only.
3. **Replace the day chips with a square day picker.** Use `ui/Tabs` (folder style) with one tab per day and an "All" tab, each with a mono count of acts. Today's day logic stays, and so does today's default of "All".
   - The stage filter becomes a `ui/Segmented` row when it fits (four stages or fewer). Otherwise it is a `<select>` labelled "Stage".
   - Both meet the touch sizes.
4. **Keep the search box and "No acts match…" as they are.** Add one line under the table: "Set times and stages come only from timed sources. Acts without one say No time and Not known yet." Use the same muted tone as the other help lines.
5. **Order stays as today:** a timed lineup goes earliest set first (`byStartTime`), untimed acts after.
6. **Update `docs/architecture/15-shared-ui.md`.** Name the lineup table and say it is the one place the lineup is drawn on the event detail.

Done when:
- the Lineup tab shows the table in all 10 themes
- ticking and unticking (solo and B2B) saves the same `seen` it did before
- the day and stage filters pass the touch sizes at 375 px and 1280 px

### 28.2 "Where every detail came from" [UI / VISUAL]
Target files: `src/components/EventSources.tsx` (new), `src/components/EventDetail.tsx`, `docs/architecture/08-sources.md`

1. **Add a card titled "Where every detail came from"** (serif heading) at the bottom of the left column, below "Your night".
2. **List one entry per distinct source**, grouped by its URL. Only use data the page already has:
   - `event.sources` (per field: `sourceType`, `sourceUrl`, `quote`)
   - the confirmed-date sources (`confirmations`)
   - the shared edition, when fields come `from` it (link as today)
   - the lineup acts' sources (`lineupActs[].sources`, grouped by URL and counted)
3. **Each entry shows:**
   - `SourceIcon` and the source's name
   - "Gave:" followed by the fields it gave, in plain words: "date, venue, city", "12 acts" or "set times for 34 acts"
   - its quote in serif italic, when there is one, in quotation marks and clipped to three lines
   - "(read by AI)" when `readBy` is `gemini`, as the candidate lists already do
   - an outbound link
   - no status badge and no date unless the data carries one
4. **Move the "Date confirmed by N sources" list here** from "When and where", so it is not shown twice. The green "Date confirmed" line can stay as a one-line summary that links down to this card.
5. **Highlight on hover or focus.** Hovering or focusing a field's "via …" link adds an accent-tint highlight to the matching source entry. It is instant, with no movement.
6. **An event with no sources gets one muted line:** "Nothing here came from a source yet. What you typed is kept as you typed it."
7. **Update `docs/architecture/08-sources.md`** with one paragraph on where sources show on the event.

Done when:
- every source the page knows about appears once, with its quote
- nothing appears that the page did not already have
- quotes are serif italic and pass contrast in all 10 themes

### 28.3 Right-hand tabs: Lineup, You saw, Changes [UI / VISUAL]
Target files: `src/components/EventDetail.tsx`, `src/components/LogView.tsx`, `docs/architecture/20-activity-log-and-recently-deleted.md`

1. **Use three tabs, in this order:**
   - "Lineup" (count of lineup acts, when there is a lineup)
   - "You saw" (count of seen acts)
   - "Changes" (no count)
2. **The default stays as today, on "You saw".** "Who you saw" stays as the heading inside the You saw panel, and every scroll-to-"Who you saw" path still works.
3. **"Changes" shows this event's history inline**, using `LogView` with `eventId`. Give `LogView` a `compact` prop that drops its page header and the "Recently deleted" block, and shows at most 20 entries.
   - Add a "See the full log" link at the bottom, which calls the existing `onOpenHistory(event.id)`.
   - Undo keeps working from the tab.
4. **Remove the "History" link from the footer.** The tab replaces it, and "Delete event" stays.
5. **Update the activity-log architecture page** to say the event detail has a Changes tab.

Done when:
- the three tabs switch with the sliding cap
- Changes lists only this event's entries and undo works there
- `?view=log` still opens the full log

### 28.4 Read rows on the left [UI / VISUAL]
Target files: `src/components/ui/ReadRow.tsx` (new), `src/components/EventDetail.tsx`, `docs/architecture/15-shared-ui.md`

1. **Add a new shared part, `ui/ReadRow`.** It shows one line: a small icon, a label in muted sans, and the value.
   - **Value:** text, mono for dates and prices, or "Not known yet" / "Not rated" / "Not set" in the faint tone when empty.
   - **Source:** the same "via …" or "from the edition" link that the field shows today, on the right.
   - **Inferred value:** the existing "Inferred" label and its reason.
   - **The whole row is a button** whose accessible name is "Edit <label>". Tapping it, or pressing Enter, swaps the row for the existing editor in place and moves focus into it.
   - **Leaving the editor** (blur, Enter in a one-line input, or Escape) returns to the read row. Saving works exactly as today. Escape keeps what was already saved and drops the unsaved draft.
   - **Rows join into one list** with square corners and hairline dividers. They are 44 px tall on phones and 40 px from 640 px up.
2. **Use ReadRow for every field in "Name and series", "When and where" and "Your night".** Merge them into two cards:
   - **"The edition":** Event, Series (with its weekend picker), Date, Last day, Days you went, Venue, Place (city, state and country together on one row, each still edited separately), Type, Weather.
   - **"Your night":** Went with, Rating, Format, Ticket price, Notes.

   The weather lookup button, Check details, the offers and the "From festival series" hints all stay. Each one sits on or under its row.
3. **Three kinds of control stay always visible, with no read mode:**
   - chip pickers (Days you went, Type, the weekend picker)
   - Rating (the stars are already one tap)
   - Notes, which shows its text and opens a textarea on tap
4. **The things-left strip** ("2 things left · Favourite set …") still scrolls to and opens the right row. "Next" moves to the next gap and opens its editor.
5. **Update `docs/architecture/15-shared-ui.md`** with ReadRow, and when to use it: a saved value people read more often than they change.

Done when:
- every field can be read without opening anything, and edited with one tap
- saves, flashes, offers and inferred labels behave as before
- the keyboard order is top to bottom
- both cards pass contrast and touch sizes in all 10 themes at 375 px and 1280 px

## Checks for every slice
1. `npm run lint --silent` and `npm test --silent` both pass, including `tests/themeContrast.test.ts`.
2. Look at the event detail in `/demo` in dark and light mode, with the violet and teal accents, at 375 px and 1280 px.
   - Use "Mesa Lights Festival 2025" and "Harbor Sound Festival Portland 2025 · Weekend 1".
   - Put before and after screenshots in the pull request.
3. Make no change to what the page fetches or saves. No new API calls. No wording changes beyond the headings and labels this brief names.
