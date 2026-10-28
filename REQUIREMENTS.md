# LiveArchive requirements

What this app is for, what it must and must not do, and the principles behind every design decision. Read it before you change anything, whether you are a person or an AI agent. [ARCHITECTURE.md](ARCHITECTURE.md) says how the app works today; [AGENTS.md](AGENTS.md) lists the rules an agent must follow. When the three disagree, this document says what the app is for, and the other two are changed to match it (say why in the same change).

## 1. Purpose

LiveArchive helps one person remember **which events they went to** and **who they saw there**.

Everything else is secondary or tertiary to that goal. A feature that makes logging an event slower, or a lineup less trustworthy, is a regression even if it adds information.

Ranked goals:

1. **Remember the event.** Logging that you were at something takes seconds and never fails.
2. **Remember who you saw.** You can say who you saw at any event, by hand or by ticking acts from a found lineup.
3. **Know the full lineup.** The app can find who else was on the bill, with a citation for every act, when you ask it to.
4. **Remember the rest.** Who you went with, notes, a rating, what you paid, which days you went, whenever you feel like adding them.
5. **Look back.** Browse your history by year, by artist, and export it as a spreadsheet.

## 2. Who uses it

- One person (the owner). No accounts for others, no social features. The one exception is a read-only share page of your past events, at a link you create and can turn off at any time (see ARCHITECTURE.md, Share page).
- Tens to a few hundred events over a lifetime; a festival can have 200+ acts.
- Used on a phone right after a show and on a laptop when catching up on old ones.
- The owner is not a developer and should never need to read logs, pick a data source or understand quotas to use the app.

## 3. Principles

These decide trade-offs. They are ordered: when two conflict, the earlier one wins.

1. **Never guess.** Missing data stays missing and the UI says so. No default dates, venues, cities, stages, ratings, setlists or lineups, and no model answering from memory. An empty answer is a valid answer.
2. **Capture beats completeness.** Saving an event must never wait on research, quota or a network call. Research happens after the event is saved and can be repeated later.
3. **Two stages, triggered separately.** Stage 1 records the event itself (name, date, place). Stage 2 finds the lineup, and only when you ask for it on a saved event. A failed or parked stage 2 never affects stage 1.
4. **Every fact has a source.** Each field on an event and each act in a lineup records where it came from: you, or a cited source (URL plus the quoted text). The UI can always show it.
5. **Your word wins.** The app suggests; it never overwrites what you typed. A suggestion is applied when it exactly confirms what you entered, or when you pick it.
6. **Simple in, structured out, room to grow.** Input is one line of plain text. Output is structured fields that can grow (companions, notes, days, seen acts) without making the first input any longer.
7. **The world and you are separate.** The canonical lineup (a fact about the world, reusable across years and lookups) is stored apart from your log (what you attended and who you saw).
8. **Spend scarce capacity only where it pays.** Stage 1 uses structured APIs and web search read in code, so it always works. Gemini quota is reserved for reading lineup pages in stage 2, and when it runs out the job waits. The one exception is yours to make: "Look again with Gemini" on an event spends a few Gemini calls reading the pages stage 1 found (R1.7a), only when you press it.
9. **No hardcoded knowledge.** No lists of festivals, venues or artists in code. Improve a source adapter or add one.
10. **Delight comes from small, reliable moments,** not from more screens: the app understanding a sloppy sentence, a one-tap "is this it?", a lineup that is already known, a running count of everyone you've seen.

## 4. Vocabulary

| Term | Meaning |
| --- | --- |
| **Event** | One entry in your log: something you attended, or plan to (an **upcoming** event, counted only once you say you went). Has a name, when, where, and your personal details. Stored in `logged_events`. |
| **Edition** | The canonical record of one occurrence of an event in the world (e.g. EDC Las Vegas on 2025-05-16, or a Porter Robinson show on 2024-10-05), with its confirmed lineup. Shared by every event that points at it. |
| **Series** | Editions with the same name across years (EDC Las Vegas). Remembers where its lineup is published. Your log has its own series name per event (R3.9), which you set; it does not change the canonical series. |
| **Act** | A performer billed at an edition. |
| **Seen act** | An act you say you saw at an event. Can exist without any lineup lookup. |
| **Billing role** | How an act was billed: *headliner*, *support*, or not stated. **Artist** lists headliners and acts with no role stated (co-bills, festivals); **Supporting artists** lists only acts a source explicitly bills as support, or that you moved there. |
| **Type** | Concert or Festival: worked out from the event, or set by you. |
| **Source** | Where a fact came from: you, or a fetched document with its URL and the quoted text. |
| **Candidate** | A suggestion from a source (event details in stage 1, an act in stage 2) waiting for you to accept it. |

## 5. Stage 1: capture the event

| ID | Requirement |
| --- | --- |
| R1.1 | Adding an event takes one line of text, for example `Porter Robinson at the Greek Theatre, Oct 5 2024` or `EDC Las Vegas 2025`. A single-artist show can be named after the artist. |
| R1.2 | The app splits the line into name, date (full date, month and year, or year) and place (venue, city) in code, without a model, and shows the split before you save. Text it cannot place stays in the name; nothing is invented. |
| R1.3 | Saving needs only a name. The event is stored immediately with exactly what you typed; every typed field is sourced as "you". |
| R1.4 | After saving, the app researches the event's details from structured sources (Ticketmaster for listings, setlist.fm for past shows by artist and date, Clashfinder for festival dates) and verifies the date with web search (Brave). Without a year, web search and setlist.fm still look across all years (web results must also name the place you gave) and offer what they find as "Is it one of these?"; if nothing turns up, the event asks "When was it?". |
| R1.5 | Research results are candidates with sources; sources agreeing on a date count together. When a source covers the full date you gave, the date is shown as confirmed (with each source and the words it used) and that candidate fills empty fields. When sources give a different date, you see up to five candidates and confirm one with one tap, or dismiss them. |
| R1.5a | A web search result counts only if its own title or description names every word of the event and writes the date in full; month-only dates and bare years never confirm anything. |
| R1.5b | The venue and city come from the same sources: listings give them directly, and for web results the app reads the event markup on the pages that gave the date (that event, that day, one place only). The city and its state are stored apart ("Las Vegas" and "NV"); a city written "City, ST" with a US or Canadian postal code is split, and that code gives the country when none is stored. |
| R1.6 | Applying a candidate records each filled field's source (URL). Fields you typed are never overwritten without your tap. |
| R1.7 | Research can be re-run at any time ("Look again"), for example after adding a date or a city. It fills empty fields and never replaces a filled one; when the confirmed source disagrees with a saved field, the field offers a one-tap "Use …" instead. A renamed event that finds nothing is searched again under the name you first typed. |
| R1.7a | When research is not thorough enough, "Look again with Gemini" (shown only when Gemini is set up, with today's calls left) runs the same research and also has Gemini read up to three of the pages web search found that name the event (and its year). Gemini only copies the words a page uses for the date and the place; the date is read from those words in code, every value must be written on the page, and results are candidates under R1.5 and R1.6 like any other, marked "read by Gemini". Out of quota, it stops, says so, and keeps what the other sources found. Plain "Look again", research after saving, and Fill gaps never use Gemini. |
| R1.8 | No candidate is fine: the event stays as typed and says no listing was found. |
| R1.9 | Every field is editable later; an edit becomes a "you" source. The last day of an event shows its start date until you change it and is stored only when it differs (a single-day event has no last day, so nothing is defaulted). Venue and city suggest what you've entered before; city also suggests real places as you type. When the state or country is missing, the event offers them from the map service in one tap, only when one place by that name clearly fits what you wrote. A venue that is in a place (set in Manage, or worked out once from your events when they all use one city) gives every event there its city, state and country, marked as from the venue; that is a link you made, not a guess. A different city a save brings (typed, researched or imported) is replaced and kept on the venue as an offer, never lost. A venue whose events disagree stays without a place until you pick one. |
| R1.10 | Past shows can be back-filled from ticket confirmation emails. Each seller's email layout is read in code (no model); every value keeps the email's link and words. The year of a date written without one is the year in which that day falls on the weekday given, within a year of the email; otherwise there is no date. |
| R1.11 | Emails propose; you decide. Found shows are listed for review, one per show, unticked (a ticket is not attendance), with refunds and cancellations flagged and shows already in your log or still ahead set apart (a show still ahead can be ticked too, and is added as upcoming, R1.14). Nothing is saved until you tick it and press Add, and personal fields are never filled from an email, except the ticket price (R1.13). A found show that is an event you already entered can be merged into it instead of added: the email fills only fields you left empty, what you entered is kept even where the email differs (and the review says so), and the merge can be undone without touching anything you changed since. |
| R1.12 | Ticket emails can be checked again at any time from the app. The app remembers how far your mail has been read and reads only ticket emails received since then (with a short overlap so nothing arriving late is missed, and nothing read twice). It reads your mail read-only and only from sellers it has a reader for (a seller whose reader is new is read through all your past mail once), including their emails someone forwarded to you (read as the original, dated from when the original was sent); new shows join the review list unticked under R1.11. |
| R1.13 | The ticket price is read from your order emails: the total the email says you paid in dollars, fees in, divided by the number of tickets the same email says it covers. It fills an event's price only when the event has none and you never set or cleared it, and the event shows it came from the email. An email that gives no ticket count, or a total in another currency, gives no price. Orders already on the review list are read once more for their price. |
| R1.14 | **Upcoming events**: an event can be added before it happens, from the capture line (on the Events home or the Table's Add box), a list import or a ticket email. One whose dates are all after today is saved as upcoming (planned), and the preview says so. Until you say you went it is left out of every count: Stats, Artists, the Map, the home tiles and the Table's summary. Once its last day has come, it asks "Did you go?" in the event view and in a "Did you go?" list on the Events home. "Yes" counts it at once and then offers the acts already on the event and the lineup's acts to tick (and the days you went, for a multi-day event); "No" keeps it as not attended, still out of every count, and can be undone. Only your answer is stored; whether it is still ahead is worked out from its dates. Moving an event's date ahead of today makes it upcoming again; an answer of "No" stays until you change it. |

## 6. Stage 2: find who played

| ID | Requirement |
| --- | --- |
| R2.1 | Lineup lookup is started from a saved event ("Find who played") and can be started, retried or redone at any time. It needs a name and at least a year. |
| R2.2 | The lookup uses the event's own name, dates and place as its search parameters, so better stage 1 data gives better lineups. |
| R2.3 | An edition already confirmed (same name and date) is reused with zero network calls. |
| R2.4 | Every proposed act cites a stored source document and a quoted span from it. Gemini only extracts from text the app fetched; names not found verbatim are dropped. |
| R2.5 | Festivals and single-artist shows are different problems. Festivals: Clashfinder first, then the promoter's page (archived copy for past years), then web search. Single-artist shows: the headliner is usually known from the event name; openers and support come from ticketing listings, setlist.fm (on that date and venue) and the venue or promoter page. Stage 2 may grow separate strategies for each without touching stage 1. |
| R2.6 | When Gemini quota runs out, the job waits with its progress kept and resumes on its own. No other model, no heuristic substitute. |
| R2.7 | You review the lineup: accept, rename, reject with a reason, add a missing act, and tick who you saw. Review decisions teach future lookups (aliases, blocklist, source accuracy, lineup URLs). A confirmed lineup can be reopened from the event to edit it again, starting from what you saved, and the review can be filtered by day and stage. |
| R2.7a | Confidence says how far to trust each act: sources that list it agree, each weighted by how often it has been right in your reviews (Clashfinder starts out above promoter pages); a source that gave the full lineup and leaves the act out counts against it, and the review says which. |
| R2.7b | Lookups can be started for many events at once from the Table (at most 50 at a time). They are queued and run one at a time in the background. A found lineup can be accepted in one tap: every act with enough evidence is kept, low-evidence acts are left out (not rejected), and acts you had ticked stay ticked; "Open" gives the full review. |
| R2.8 | Confirming writes the canonical edition and updates your event's seen acts. Acts you had already marked as seen stay ticked; acts you added by hand that the lineup lacks are kept. |
| R2.9 | A billing role is stored only when a source's own words bill the act ("X with special guest Y", "supported by", "w/"), with a billed act named on each side of the marker, and those words are kept as the quote. A title without a marker, or with no act before it ("An Evening with X"), gives no role. Sources that disagree give no role. In review you can set any act's role; your choice is kept and passed to your seen acts. |

## 7. Your details

| ID | Requirement |
| --- | --- |
| R3.1 | Seen acts can be added by name on any event, with or without a lineup. While you type, acts you entered on other events are offered, spelled as you wrote them before. |
| R3.2 | Optional, added any time: who you went with, notes, a rating (1 to 5), ticket price, which days you went for multi-day events, and the **Format** (club night, warehouse party, block party, ... in your words, separate from Concert or Festival; one or more values). None is ever pre-filled, except a ticket price your own order email states (R1.13). For days, giving none means you went every day, so every day shows ticked and you untick the ones you missed; nothing is stored until you do. |
| R3.3 | New personal fields are added to the event without making capture longer. They appear in the event's detail view and the export. |
| R3.4 | Who you saw is shown as **Artist** and **Supporting**. Acts from a lineup carry its role; you can move any act between the two, or tap its name to mark it Headliner, and that choice is yours from then on. When the event's own name names an act that a source lists for this event (the Ticketmaster listing or setlist.fm show it was matched to, or the lineup), the event offers "X as Artist?" (or "as Supporting?" when the name says "X with Y") as one tap; nothing is added until you tap it. The same is offered for an act you saw at another event whose name appears in this one, and for a part of the name (before a subtitle, split on "with", "b2b" and commas) that MusicBrainz knows as an artist of exactly that name. |
| R3.5 | **Type**: an event is a **Festival** when it spans more than one day, more than 5 acts are known (confirmed lineup or acts you saw), or its date was matched to a Clashfinder edition; a **Concert** when a confirmed lineup has 5 acts or fewer on one day; otherwise **not known yet**. You can set it yourself, and your choice wins. Only your choice is stored; the rule is worked out again whenever dates or the lineup change. |
| R3.6 | **Favourite set**: you can mark one act you saw as your set of the night. It shows first, with a heart, in the Table and is a CSV column. |
| R3.7 | **Set times**: when a source times the sets (Clashfinder), each act you saw shows its stage and time, cited to that source. Nothing is shown for an act no source times. |
| R3.9 | **Series**: you can link the years of a festival or tour by giving each event the same series name (EDC Las Vegas). An event in a series shows everywhere as the series and its year ("EDC Las Vegas 2024"), with the town from the event's own city added when the series name does not say it ("EDC" in Las Vegas shows as "EDC Las Vegas 2024"); the name you typed stays on the event and is what a lineup lookup reads. The Table offers events whose names match once the year (and a weekend or day number) is taken out and that share a city (an event with no city joins the only city that name is known in), named with that town ("EDC Las Vegas"), as a group you can rename, untick from and link in one tap; nothing is linked without that tap. You can rename a series for all its events, add an event to it, or take one out. For a festival with more than one weekend you can pick the weekend (1, 2, ...) on each event, shown as "Coachella Indio 2024 · Weekend 1"; the panel offers the weekend your own name for the event gives ("Weekend 2", "W1") and it is saved only with your tap. Series is a Table and Map filter (also one tap from an event's series tag in the Table, or "Show in Table" in the Series panel) and a CSV column read back on import. Stats shows your series: editions, the years you went and your longest run of years in a row, cities, acts seen and the acts you saw at more than one edition; a series opens it in the Table. |
| R3.10 | **Set type and B2B**: you can mark an act you saw as a DJ set or a live set, and pair acts as a B2B. A B2B shows as one slot ("Sasha b2b John Digweed (DJ set)"), but each act in it is still its own seen act, so each artist is credited with the event in Artists, Stats and the Saw column. An act in a B2B can also have its own solo set at the same event ("+solo", or typing its name again), with its own DJ or live mark; it shows as a second slot ("Sasha (solo, Live set)") and the artist is still counted once for the event. A lineup's own words can propose them: an entry billed "A b2b B" becomes two acts paired as a B2B, and one billed "X (DJ Set)" becomes X marked as a DJ set; each part is still quoted from the page. They apply to acts you tick, the review lets you pick each act's set type, and your own marks survive a review unless you change them there. Lineup names you have used before keep your spelling (capitalization aside); names a source wrote all in one case are put in Proper Case. A CSV "Sets" column lists them and is not read back. |
| R3.11 | **Artist in the title**: an event not in a series that is not a festival, with one or two acts you saw that are not billed as support, shows them before its name ("Gryffin - Alive Tour", "Above & Beyond, Seven Lions - Pier Party", or "Sasha b2b John Digweed - Pier Party" when the two played B2B) unless the name already says one of them. The name you typed is unchanged, shown in the event view, and is what a lineup lookup reads. |
| R3.8 | **Weather**: on request, the weather on the event's days (high, low, rain, conditions) from the Open-Meteo archive, with a link to what was read. Only for a past date and a city that matches exactly one place; otherwise the event says why and stays without. |

## 8. Views

| ID | Requirement |
| --- | --- |
| R4.1 | **Events** (home): the capture line at the top, then a summary to take in at a glance: what needs you (email rows to review, events to confirm you went to, events missing a date or a pick, lineups to review), tiles for events, artists seen, venues and this year so far (events you went to only), an "On this day" line on anniversaries, a "Did you go?" list of upcoming events that are over (R1.14), events just added, events still ahead, and your five most recent. Each row shows when, where, who you saw and what it still needs as a quiet hint, not a warning. The full list is the Table view. |
| R4.2 | **Event detail**: edit fields, see each field's source, pick research candidates, manage seen acts and personal details, run and review the lineup lookup. |
| R4.3 | **Artists**: everyone you've seen at events you went to (not upcoming or unconfirmed ones), one card each: how many times, the years and cities you saw them in, how often a source billed them as headliner or support, your favourite sets, and their most recent events (the rest a tap away, or in the Table filtered to them). Order by most seen, recently seen, first seen or A to Z, in headed groups (times seen, year, letter), with a bar under the header that jumps to a letter (A to Z) or a year (recently or first seen), and a Back to top button once you have scrolled down. A Compact view shows one line per artist (name, favourite and headliner marks, main city, years, times seen) that opens to the full card; Detailed shows the cards. The choice is remembered. Roles and favourites count only where stored. |
| R4.4 | **Export**: download events as CSV (one row per event, with its type, whether you went (Yes, Upcoming, Not confirmed or No; not read back), Artist and Supporting artists, and all seen acts joined) for a spreadsheet, from the Table view: all events, or only the rows the filters show. |
| R4.7 | **Table**: every event as a sortable row, with filters for year range, type (concert, festival, not known yet), venue, city, state, country, an act you saw, who you went with, minimum rating, what an event still needs, where it was added from (typed or ticket email), whether you went (went, upcoming, to confirm, didn't go; upcoming and unconfirmed rows carry a badge), and whether seen acts, rating, price, companions or a confirmed lineup are set. Empty fields are gaps, not zeros: they sort last, can be filtered for, and summary figures say how many events they cover. The summary counts only events you went to and says how many are upcoming or to confirm. Filters live in the page address so a view can be bookmarked. Read-only; a row opens the event detail. It is also where bulk editing, CSV import and sheet sync live; spelling clean-up (rename everywhere, merge, AKAs) lives in the Manage tab. |
| R4.10 | **Fill gaps**: from the Table, pick one kind of missing data (date, venue, city, state and country, type, who you saw, a lineup to review, favourite set, format, who you went with, rating, price, weather) and see the events shown that lack it (who you saw, favourite set and rating only for events you went to), each with a field to type into; Enter saves it as yours and the row goes. For missing dates and places it can look up details for all of them; for missing acts it offers the artists named in each title (the same suggestions as R3.4, ticked when a source or another of your events backs them, MusicBrainz matches on request and unticked) and adds the ticked ones only when you press Add, and it can find their lineups; for missing weather it can look it up for all of them; for a missing state or country it looks them up from each city and saves them on "Use" or "Use all". Lookups only propose. |
| R4.9 | **Import a list**: read a CSV of past events you kept elsewhere (Notion, a spreadsheet, this app's export) into rows you check before saving. The same event already in your log or email review is merged into it, filling only empty fields and adding acts and people; one that only shares a day under another name waits for your choice. Unreadable dates and values that look wrong are flagged, never fixed. A row from this app's own export (it has an ID) is folded into its event the same way: the app is the source of truth, so a list only fills what an event lacks and never changes what it says. An act or person already on the event under another of their names (an AKA) is not added again. |
| R4.12 | **Google Sheets sync**: from the Table, sign in to Google and link a sheet (or make a new one). Sync is one way: the app is the source of truth and writes your log into the sheet; nothing typed in the sheet is read back. Before edits made in the sheet (or columns of your own) are replaced, you're told how many and asked to confirm. A sheet that changed while you confirmed, or a tab the app can't read, is left as it was. |
| R4.8 | **Stats**: events per year (empty years shown as gaps, a bar opens that year in the Table), a year in review (events, artists, first-time artists, most seen, top venue, who you went with most, busiest month, average rating with how many are rated), top artists, venues, cities and companions (each opens the Table filtered to it), and fun facts (first event, busiest 30 days, longest break, acts per event). Only events you went to count; events still ahead, waiting for you to confirm, or not attended are left out, and the view says how many are waiting. |
| R4.11 | **Map**: a dot per city you went to (events you went to only), sized by how many events, with the Table's filters (search, years, an act you saw, type, format, who you went with) kept in the address and shared with the Table. Year playback adds each year's events in turn; with an act picked, a trail joins the cities you saw them in, oldest first. Counts of cities, states or provinces and countries. Cities are placed from the city you stored: a state or country you wrote must match, a bare name shows the biggest place by that name and the map says so, and cities it cannot place are listed. Points are for display only and never stored on an event. |
| R4.5 | Operational detail (job logs, sources configured, quota) stays out of the way, one tap deep. |
| R4.6 | No demo or seeded data. An empty app is empty. |

## 9. Non-functional requirements

- **Hosting**: a Cloudflare Worker at concert.charliechonguyen.com with Supabase as the only durable store; a Node server for local development. See ARCHITECTURE.md.
- **Cost**: free tiers only (Gemini free tier, Ticketmaster, setlist.fm non-commercial, Clashfinder, Brave Search free plan, Workers Free, Supabase free).
- **Respect sources**: all fetching through the shared rate-limited fetcher (MusicBrainz 1 request/second); AXS is never scraped; credentials are redacted from anything stored or shown.
- **Responsiveness**: capture returns as soon as the row is stored. Stage 1 research completes within a single request. Stage 2 runs in the background and the UI polls.
- **Privacy**: the site holds one person's history; put it behind Cloudflare Access.
- **Quality gate**: `npm run lint` and `npm test` pass before every commit; new parsing rules, adapters and stage rules come with tests.

## 10. Capabilities and limitations of the sources

| Source | Stage | Can | Cannot |
| --- | --- | --- | --- |
| You | 1, 2 | Anything; always trusted | n/a |
| Ticketmaster Discovery | 1, 2 | Name, dates, venue, city for upcoming and recent events; billed attractions | Most past events drop out; festival listings may name headliners only |
| setlist.fm | 1, 2 | Past shows by artist and date (venue, city); confirms who actually performed | Needs a key; coverage depends on fans; not a full lineup |
| Clashfinder | 1, 2 | Festival editions with start dates; full festival lineups with stages and times, archived for past years | Crowd-sourced; mostly festivals; fantasy clashes are ignored |
| Promoter pages (and Wayback) | 2 | The official lineup, read by Gemini | Pages are overwritten each year, hence archived copies |
| Brave web search | 1, 2 | Confirms dates from result titles and descriptions (and venue and city from the event markup on those pages); finds lineup pages when nothing else did | Results can mix in other editions or tour dates, so strict same-event filtering applies; free plan has a monthly cap |
| Your ticket emails | 1 | Name, date, venue and city of shows you bought tickets for, from Ticketmaster, Live Nation, Tixr, DICE, Resident Advisor, Eventbrite, AXS, Front Gate and TicketWeb confirmations (and tickets friends transferred to you on AXS); refunds and cancellations | A ticket is not attendance; layouts change; many omit the year; other sellers' emails are listed as unreadable |
| Gemini (free tier) | 2; 1 only when you ask | Reads fetched pages and extracts names verbatim (stage 2), or the words a page uses for an event's date and place ("Look again with Gemini") | Never answers from memory; ~50 calls/day budget |
| Open-Meteo geocoding | capture, map | City suggestions as you type ("City, ST"); the point on the map for a city you stored; free, no key | Suggestions and map points only; never fills a field on its own |
| Open-Meteo archive | event detail | Weather on the event's days, on request; free, no key | Only for a city the geocoder places exactly once; stored with its URL |
| MusicBrainz | after 2, event view | Stable artist IDs; whether a name in your event's title is an artist (a one-tap suggestion) | Not a lineup source |
| AXS website | none | n/a | No public API; scraping breaks its terms (your AXS ticket emails are read as above) |

## 11. Out of scope

- Multiple users (other people's own accounts), social feeds, recommendations. Sharing is limited to the read-only share page.
- Ticket purchasing, calendars of upcoming shows beyond your own, notifications (the "Did you go?" prompt waits in the app).
- Inferring what you saw from lineups (you tick it, or it isn't recorded).
- Importing from email without review, or signing in to ticket accounts (connecting your own Gmail read-only for Check email is in scope).

## 12. Open questions

- Photos per event: worth the storage, or link out to an album?

## 13. Ideas for delight (not yet built)

Ranked by how much they serve the purpose for how little complexity they add.

1. **Artist pages**: every time you saw someone, with the venues and who you were with.
2. **Back-fill mode**: type one line per event in a box (a whole year at once) and stage 1 handles each.
3. **Setlists**: for a seen act at a single-artist show, link the setlist.fm setlist for that night.
4. **Share card**: an image of one event or one year, generated from your own data.
