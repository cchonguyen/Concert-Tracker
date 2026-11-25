# Ticket stub: LiveArchive 2.0, stage 4

Status: design approved by Charlie on 25 Nov 2026 (Pacific). Not started. Slices 29.1 to 29.9 below wait for his go on this plan.

Mockups: https://claude.ai/artifact/FJmhKgBktTqwWVdvdULTjX (the "Decided" list at its foot is part of this spec). Earlier options page: https://claude.ai/artifact/3jqdZx2JzFpF8xVtmn7xjC.

This lifts the "ticket stub is parked" line in `docs/specs/design-refresh-2.md` section 1.

## The idea in one paragraph

One shape, two jobs. The **true ticket** is built from one event's own facts. It is the event detail hero and, at a small size, shows off one event anywhere else (Home "Last show" and "On this day", Share cards). The **framing stub** borrows only the shape (perforation and notches) to frame summaries: the Home year ticket, the Stats year header, and the headers of the ranking lists and Summary's year groups. It promises nothing about tickets.

## Decisions (Charlie, 25 Nov 2026)

1. True ticket: desktop is two columns (body | stub end), phone is two rows (body over stub end).
2. Body: event name; who you saw, with the big line chosen by the rules below and everyone else small; date or dates; venue and place.
3. Stub end, in this order, each piece only when its fact exists, until the space is full: Admit number, short date, barcode, ticket facts (price, order last 4, seller, ticket count), Went stamp. Your show number and the shorthand code only when room is left.
4. The poster's pills, "Date confirmed", the lineup count, the things-left strip, "Did you go?" and the star rating move to one bar under the hero.
5. Share leaves the top menu fully and becomes its own Library page, with two tabs: Your link (today's Share panel) and Event cards.
6. Ranking lists (Top artists, Top venues, Top cities) and Summary's year groups get a stub header: roomy padding, small perforations between its parts, then one large perforation notched on the left and right above the table. The rows below stay plain joined rows.
7. The Table view keeps its header as it is. No filter or sort inside a stub.

## Rules (from AGENTS.md, applied here)

- **Nothing invented.** Every printed value is stored, or worked out in code from stored values. A missing one is left out, never shown as a guess. The ticket never prints "Not known yet"; it just gets shorter.
- **The big line never makes a headliner from list order:**
  - 1 or 2 headliners (stored, or inferred with the "Inferred" label kept in the lineup) go big, joined with "&". Everyone else you saw goes small, supports first.
  - 3 or more headliners: the first two go big, "and N more headliners" joins the small line.
  - No roles and 1 or 2 acts seen: those acts go big. This says who you saw, never calls them headliners.
  - No roles and 3 or more acts: the event name goes big and every act is small.
  - Nobody seen yet: the event name goes big, with a "Who did you see?" link.
  - When the event name equals the big line, the event name line is dropped.
- **Admit** is 1 plus the number of people in your "With" list.
- **Barcode and shorthand** are drawn in code from the event's own id and names, so each is unique and never changes. They are decoration: hidden from screen readers and not scannable.
- **Ticket facts** (seller, order, ticket count) come from the ticket email import the event came from or was merged with. The order shows only its last 4 digits. The price is the event's own price (yours or the email's, as today).
- **Private.** Admit, price, order, seller, ticket count, rating, notes and companions never appear on a share card, the public share page or any shared table. A shared card's stub end uses the Went stamp, shorthand and barcode instead.
- **Motion** (the tear on "Yes, I went", the stamp) is off under reduced motion, which shows the finished state.
- **Touch and reading:** buttons in the bar are at least 44 px tall on phones. The stub end has one plain sentence for screen readers, such as "Admit 3, $189, went 2 November 2026."
- Saving, attendance, review and lookup behaviour do not change. This is a display change plus one read of facts already stored.

## Depends on

- Gemini slices 28.2 to 28.4 (`docs/specs/design-refresh-2-detail-gaps.md`) edit `EventDetail.tsx`. Slice 29.4 starts only after 28.4 merges. Slices 29.1 to 29.3 and 29.5 to 29.9 do not touch those parts and can start now.
- No database migration. Share settings are stored as JSON (`share_links.settings`, 0015), so a new switch needs no column.

## Slices

Each slice is one pull request. Build with Haiku per the project rule unless Charlie says otherwise.

- **29.1 Ticket rules in code** [CORE / DATA]. A pure module for: the big line and small line (rules above), Admit, short date (month-only gives "SEP 24"), shorthand code, barcode bar widths, show number, and which stub-end pieces fit in a given size. Target files: `src/services/ticket.ts`, `tests/ticket.test.ts`.
- **29.2 Ticket facts for an event** [CORE / DATA]. A read that returns seller, order last 4 and ticket count for an event from its ticket email import, for the owner only. Target files: `src/server/events/importRoutes.ts`, `src/services/lineupApi.ts`, `tests/ticketFacts.test.ts`.
- **29.3 The Ticket and StubHeader components** [UI / VISUAL]. `Ticket` with `layout` columns or rows and `size` hero or small; `StubHeader` with segments and the large notched perforation. Perforation and notch styles in the shared CSS. Target files: `src/components/ui/Ticket.tsx`, `src/components/ui/StubHeader.tsx`, `src/index.css`.
- **29.4 Event detail hero and bar** [UI / VISUAL]. After 28.4. The poster becomes the Ticket. A new bar under it holds status, checks, stars, things-left and "Did you go?" (Yes tears the stub and stamps it). The attendance box and rating leave the left column. Target files: `src/components/PosterHeader.tsx`, `src/components/HeroBar.tsx`, `src/components/EventDetail.tsx`.
- **29.5 Stub headers on lists** [UI / VISUAL]. Top artists, Top venues and Top cities, and Summary's year groups. Target files: `src/components/ArtistsView.tsx`, `src/components/StatsView.tsx`, `src/components/EventsHome.tsx`.
- **29.6 Home anchor** [UI / VISUAL]. The year tile becomes the framing ticket (round 2 look). "Last show" and "On this day" use the small Ticket. Target files: `src/components/YearTile.tsx`, `src/components/HomePage.tsx`.
- **29.7 Stats year header** [UI / VISUAL]. The year totals as a framing ticket with the change against last year on the stub end. Target files: `src/components/StatsView.tsx`.
- **29.8 Share page in Library** [UI / VISUAL]. Share becomes a Library page with Your link and Event cards tabs, and leaves the top menu. Your link carries today's panel unchanged. Target files: `src/services/nav.ts`, `src/components/pageIcons.ts`, `src/App.tsx`, `src/components/AppHeaderMenu.tsx`, `src/components/SharePage.tsx` (from `SharePanel.tsx`).
- **29.9 Event cards** [CORE / DATA]. Pick an event, choose what shows (who you saw, exact dates, venue), and save the card as an image drawn in the browser. Private fields are never drawn. Target files: `src/components/ShareCards.tsx`, `src/services/shareCard.ts`, `tests/shareCard.test.ts`.

Later, not in this plan: a per-event share link (needs new server work), and a "Use ticket cards on the page" switch for the public share page.

## Docs to update while building

- `ARCHITECTURE.md` and `docs/architecture/15-shared-ui.md`: Ticket and StubHeader as shared parts (29.3).
- The share page section of the architecture docs: Share as a Library page (29.8), and event cards (29.9).
- `docs/specs/design-refresh-2.md` section 1: the ticket stub is no longer parked (this PR).
