# Gemini package "Back Office": LiveArchive 2.0, stage 2

Status: approved by Charlie on 24 Nov 2026 (Pacific). Stage 0, Track A and the "Ledger & Lobby" package have all merged, so `main` already has:
- the tokens, the fonts and the contrast test
- the shared parts `Tabs`, `Ledger`, `KindPill`, `HintPill`, `Stars`, `Equalizer` and `Popover`
- the refreshed Summary, Table, Agenda, Month, River, Home, event detail and Stats screens

This is half of stage 2 (section 8 of `docs/specs/design-refresh-2.md`). Claude builds the other half, Track C, at the same time. "Back Office" covers the screens behind the main library: the global archive, Manage, the admin panels, Artists and the map, the import screens, and sharing and the log.

These screens work today and pass contrast, because the colour engine remaps their old `zinc-*` and `violet-*` classes. This package moves them onto the 2.0 look.

## Before you start
1. Read these files:
   - `AGENTS.md`
   - `CLAUDE.md`
   - `.spec/EXTERNAL_AGENT_RULES.md`
   - `docs/specs/design-refresh-2.md` (sections 2 to 5 are the visual rules)
   - `docs/architecture/15-shared-ui.md`
2. Look at a refreshed screen as a model, for example `src/components/EventDetail.tsx` or `src/components/TableView.tsx`.
3. Check that origin has no `harness-main-red` tag.
4. Work one slice at a time, in the order of the table below. Each slice already has a line in `.spec/PROGRESS.md` and a GitHub issue.
5. Start a slice with `node .harness/scripts/start-slice.mjs 25.N`.
6. Work on a branch named `antigravity/dr2-25.N`, and open one pull request into `main` whose body says `Closes #<issue>`.

## What "moved onto the 2.0 look" means
- **Colours are tokens.** Replace every Tailwind colour name with its token. Examples:
  - `zinc-*`, `neutral-*`, `gray-*` and `slate-*`
  - `violet-*`
  - `emerald-*`, `amber-*`, `rose-*` and `red-*`
  - `sky-*` and `blue-*`
- **The usual swaps:**

  | Old class | Token |
  |---|---|
  | `bg-zinc-950` | `bg-page` |
  | `bg-zinc-900` | `bg-surface-1` |
  | `bg-zinc-800` | `bg-surface-2` |
  | `border-zinc-800` | `border-line` |
  | `border-zinc-700` | `border-line-strong` |
  | `text-zinc-50`, `text-zinc-100`, `text-zinc-200` | `text-text` |
  | `text-zinc-300`, `text-zinc-400` | `text-text-muted` |
  | `text-zinc-500`, `text-zinc-600` | `text-text-faint`, only for text that is not needed to use the screen; otherwise `text-text-muted` |
  | `text-violet-*` | `text-accent` |
  | `bg-violet-*/10` | `bg-accent-tint` |
  | `border-violet-*/30` | `border-accent-tint-line` |
  | emerald | `good` |
  | amber | `warn` |
  | rose and red | `bad` |

- Never use `text-white` on an accent, and never hard-code a hex colour.
- **Shape.**
  - Cards and panels have 12 px corners (`rounded-card`).
  - Buttons and inputs have 8 px corners (`rounded-control`).
  - Lists of records use `ui/Ledger` rows with square corners.
- **Type.**
  - Panel and section titles use Newsreader (`font-display`, weight 400).
  - Dates, counts, ids, prices and table headers use `font-mono` with tabular figures.
  - Everything else stays sans.
- **Shared parts, not copies.**
  - Spinners become `ui/Equalizer`.
  - Badges become `ui/Pill`, `KindPill` or `HintPill`.
  - Tab rows become `ui/Tabs`.
  - Ratings become `ui/Stars`.
- **Accent spend.** At most one solid accent button per screen: the main action. Other buttons are outlined or plain.
- **Touch targets.** 44 px on phones, and 36 px from 640 px up. Close buttons are 40 px.

## Rules that apply to every slice
- **No change to behaviour.** What each screen fetches, saves, shows and in what order stays exactly as it is. This package is visual only. Do not rename labels or reword text, except to remove a brand name from a button.
- **Missing stays missing.** Keep "Not known yet", "No date yet" and similar text. Never fill a gap with a guess.
- **State is never shown by colour alone.** It always comes with an icon or a word.
- **Motion.** Use the `motion` package, keep it under 200 ms, and turn all of it off under `prefers-reduced-motion`.
- **Do not edit Claude's files.** These belong to Stage 0, Track A or Track C:
  - `src/index.css`, `src/services/theme.ts` and `src/services/eventTint.ts`
  - everything in `src/components/ui/`
  - `src/App.tsx`, `ThemePicker.tsx`, `AppHeaderMenu.tsx`, `SampleBanner.tsx` and `src/Boot.tsx`
  - `EventsHome.tsx`, `EventDetail.tsx`, `EventTitle.tsx`, `PosterHeader.tsx`, `StatsView.tsx` and `timeline/`
  - `TableView.tsx` and `CaptureBar.tsx`
  - `QuickAdd.tsx`, `AboutDialog.tsx`, `AccountPanel.tsx`, `NoticeModal.tsx` and `SuggestInput.tsx`
  - `CheckDetails.tsx`, `FillGaps.tsx`, `LineupReview.tsx`, `LineupProgress.tsx`, `PasteSetTimes.tsx` and `EditionNameGaps.tsx`
  - `SeenGenres.tsx`, `EmailCard.tsx`, `ReaderPanel.tsx` and `FinderReadoutPanel.tsx`

  If a slice needs a change in one of them (for example a new prop on a shared part), write the file and the reason under "Immediate Next Step for Claude" in `.spec/SESSION_HANDOFF.md`. Then carry on without it.

## Slices

| Slice (issue) | Id | Slice | Target files | Done when |
|---|---|---|---|---|
| 25.1 (#725) | B1 | Global archive: Artists and Brands | `src/components/CanonicalArchive.tsx` (the `CanonicalArchive` shell, `ArchiveArtists`, `ArchiveBrands`) | Tokens throughout, record lists on `Ledger`, mono counts, spinners are `Equalizer`. |
| 25.2 (#726) | B2 | Global archive: Series | `src/components/CanonicalArchive.tsx` (`ArchiveSeries`, `SeriesDetail`) | Same, with a serif title on the series detail and the "Create series" form on 8 px controls. |
| 25.3 (#727) | B3 | Global archive: Editions, Lookups and Changes | `src/components/CanonicalArchive.tsx` (`ArchiveEditions`, `ArchiveLookups`, `ArchiveChanges`) | Same, with mono dates and the lookup status in `HintPill` (busy, done or needs-you). |
| 25.4 (#728) | B4 | Global archive: edition detail | `src/components/CanonicalArchive.tsx` (`EditionDetail`, `EditionFactsForm`, `ActRecord`) | Same. The lineup stays a table, source quotes use serif italic (`font-display italic`), and no raw colour classes are left in the file. |
| 25.5 (#729) | B5 | Global archive entries | `src/components/CanonicalArtistEntry.tsx`, `src/components/MergeEditionModal.tsx` | Tokens, card and control corners, mono dates. |
| 25.6 (#730) | B6 | Manage | `src/components/ManageView.tsx`, `src/components/ManageEntry.tsx` | Tokens. Manage lists use `Ledger`, and filter chips match the Table's. |
| 25.7 (#731) | B7 | Admin panels | `src/components/DataHealth.tsx`, `src/components/MembersPanel.tsx`, `src/components/AdminInbox.tsx`, `src/components/VenueFillPanel.tsx` | Tokens, serif panel titles, mono counts, Ledger rows, and `HintPill` for states. |
| 25.8 (#732) | B8 | Artists and the map | `src/components/ArtistsView.tsx`, `src/components/ArtistGenresPanel.tsx`, `src/components/MapView.tsx` | Tokens. The Ranking sort buttons reach the touch sizes, and the map's credit line passes 4.5:1 (it is 3.13:1 today in dark mode). |
| 25.9 (#733) | B9 | Imports | `src/components/ImportReview.tsx`, `src/components/ListImport.tsx`, `src/components/BrowserScan.tsx`, `src/components/SheetSync.tsx` | Tokens, Ledger rows for imported shows, and spinners are `Equalizer`. |
| 25.10 (#734) | B10 | Sharing, series and the log | `src/components/SharePanel.tsx`, `src/components/CollaborationsCard.tsx`, `src/components/SeriesPanel.tsx`, `src/components/LogView.tsx` | Tokens, Ledger rows for the log, mono times. |

B1 to B4 change the same file, so build them in order. The rest can go in any order.

A slice is done when its target files hold no Tailwind colour names (check with `grep -E "(zinc|violet|neutral|gray|slate|emerald|amber|rose|red|sky|blue)-[0-9]"`), its checks pass, and it changes no behaviour.

## Checks for each slice
1. `npm run lint --silent`, which runs the typecheck.
2. `npm test --silent`. This includes `tests/themeContrast.test.ts`.
3. Look at the screen in dark and light, with at least violet and teal, at phone width (375 px) and desktop width (1280 px). The admin screens show only to the owner. In sample mode (`/demo`), use the screens that sample mode offers, and say in the pull request which screens you could not open.
4. Commit with `node .harness/scripts/finish-slice.mjs "<message>"`. Then update `.spec/SESSION_HANDOFF.md` as section 3 of `.spec/EXTERNAL_AGENT_RULES.md` says.

Put the check results and before-and-after screenshots in each pull request. Claude reviews each one before it merges.
