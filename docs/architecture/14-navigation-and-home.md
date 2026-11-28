# Navigation and Home

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Sections and Routing

The header has three places: **Home**, **Library**, and **Explore**.
- **Library** holds Summary (your events list, Library's first page), Table, Manage, Log (Recently deleted shows with Restore and your change history in `src/components/LogView.tsx`, scoped per member), and Share. Manage is hidden for members without `canManage` (opening its URL falls back to Summary).
- **Explore** holds four strip tabs: **Timeline** (grouping Agenda, Month, Heatmap, and River under a `Segmented` switch inside `TimelineTab.tsx`), **Map**, **Stats**, and **Ranking** (`Artists`, `Genres`, and `People`).

`src/services/nav.ts` holds the route model (`stripTabsFor`, `stripTabFor`, `openStripTab`) and `?view=` names (`table`, `agenda`, `month`, `heatmap`, `river`, `map`, `stats`, `ranking`, `share`). Old names (`?view=timeline`, `?view=artists`, `?view=events`) and unknown values open Home. The remembered subtab per section and last timeline view live in `liveArchive.subtabs` (`localStorage`, errors ignored). Each page shares its icon via `src/components/pageIcons.ts`.

## Layout, Widths, and Mobile Strip

- **Widths:** Table is `max-w-6xl`; every other page (including Map) is `max-w-3xl`. The top bar and sub-tab row stay `max-w-6xl` so navigation never shifts width.
- **Page headers:** Titles use `PosterHeading` (`src/components/ui/PosterHeading.tsx`), with each page's one-line description from `PAGE_BLURB`. `BackToTop` appears after one screen of scroll on long views.
- **Phone strip:** Subtab strips show icons only on phones (with title + `aria-label`). On a phone's first visit, `"Tap an icon to switch pages."` shows for 6 seconds or until a tap (`liveArchive.tabHintSeen` in `localStorage`).

## Home (`src/components/HomePage.tsx`)

- **Hero & Capture:** Opens with a `PosterHeading` headline (second half in `--la-second`) and one-line prompt (`"Every show you've ever been to, in one place."`, or `"Start with the last show you remember"` when empty), followed by `CaptureBar` (stage 1) and Import a list.
- **Email Check:** When configured, `EmailCard` (`src/services/copy.ts`) explains what the browser ticket scan reads and saves (matching `BrowserScan.tsx` and `packages/ticket-scanner`).
- **Feature Tiles & Page Tips:** Seven `PostIt` tiles (`FeatureTiles`, including `"Show friends your year"` → Share) follow the page-tip rules (`src/services/tips.ts`, `TipsProvider` in `src/components/ui/TipsContext.tsx`, stored on `user_settings` / `app_settings` key `tips`). Page tips (`Callout`) show on the first 3 visits to a page, then fold into the header `?` (`TipsButton`), unless `"Show all tips"` is on. Folded tips animate back in unless reduced motion is set.
- **Milestones:** `MilestoneCard` (`src/services/milestones.ts`) celebrates crossing 1, 10, 50, 100, 250, 500, or 1,000 `wentTo` shows or 100 `distinctActs` with inline canvas confetti (skipped under reduced motion), persisted on the account (`milestone` key).
- **Needs You & Section Tiles:** Lists shows awaiting `"Did you go?"`, ticket emails to review, and researching lineups, followed by `PostIt` link tiles for Library and Explore pages with live counts.

## Quick Add & Global Menu

- **Quick add (`src/components/QuickAdd.tsx`):** Opens capture, email check, and import from any page (header button on desktop, floating `+` on phones, `N` shortcut when not typing). Saving shows `"Saved · Open"` for six seconds.
- **Menu (`src/components/ui/MenuButton.tsx`):** Holds Your account and Members (multi-user only), Your data (Import, Export, Sheets via `DataActions.ts`), and Theme (`ThemeControls` in `ThemePicker.tsx`: Dark/Light/System `Segmented` mode, 5 accent colors, and the 5-swatch `TicketStylePicker`).
