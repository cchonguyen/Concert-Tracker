# Neon cleanup: soft solid pills, chips and messages

Approved by Charlie 2026-11-28: "I would go with the recommendation", with one change: "move away from hairline strokes on things like pills and chips and reserve them for tables and other structural elements … soft solid wins out for me over quiet." Mockups (before, recommended, alternatives, switchable Table mock): https://claude.ai/artifact/7ZZNWUJrcfcfzQo4dAxjPA (source in `/mnt/project-files/neon-cleanup/`). The "Quiet with a dot" style on that board is replaced everywhere by **soft solid** below.

## The problem

"Faux neon" is a control or label drawn with a coloured 1px outline, a dark or transparent fill and text in the same colour (`border-warn/45 text-warn`, `border-accent-tint-line text-accent`, `border-bad/45 bg-bad/10 text-bad`, …). It is the 2.0 look. There are 64 of them in 34 files, so they all shout at the same volume and clash with the 3.0 landing look (`docs/specs/landing-look.md`: poster headings, post-its, solid fills).

## Rules (become part of the design system)

1. **At most two neon pieces per page.** The only kept ones are the **Today line** (Table, Timeline agenda) and the ticket's **WENT stamp** (`src/components/ui/Ticket.tsx`). New neon needs a line in this spec saying which page it replaces a piece on.
2. **No hairline strokes on pills, chips, badges, tags, toggle chips or count bubbles.** They are filled shapes with no border. Hairlines stay on structural things only: tables and rows, cards and panels, inputs, the `Segmented` frame, dividers, and buttons (`Button` secondary keeps its border).
3. **Text on a tinted fill is ink (`text-text`), not the tint's colour.** Colour lives in the fill and in the icon.
4. **Pick the look by job:**

| Job | Look | Example |
| --- | --- | --- |
| The one thing on a page that needs you | **Solid ink**: full colour fill, dark ink | "2 to confirm", tips "?" when on |
| Anything that repeats per row or per item | **Soft solid**: tinted fill, ink text, coloured icon, no border | "Did you go?", gap counts, "Counted", filter chips, offers |
| The page's signature action | **Layered**: solid raised fill with a hard coloured offset shadow, no border | Table's "Fill gaps" |
| A done or empty moment | **Paper**: a small `PostIt` | "All filled in" |
| Billing | **Solid second colour**, mono capitals | "Headliner" |
| Messages (error, saved, warning, info) | **Solid card**: `surface-2` card with its normal card line, ink text, colour only in a solid icon tile | Every error and success box |

## Tokens (`src/styles/tokens.css`, `src/styles/landing-look.css`)

Add to `:root` and `:root[data-theme='light']`, in the same parseable form as the existing tokens (hex, `var()`, or `color-mix(in oklab, A P%, B)`) so `tests/themeContrast.test.ts` can check them:

| Token | Dark | Light | Tailwind |
| --- | --- | --- | --- |
| `--la-good-soft` | `color-mix(in oklab, var(--la-good) 16%, var(--la-surface-1))` | same formula at 12% | `bg-good-soft` |
| `--la-warn-soft` | warn 16% over surface-1 | warn 12% | `bg-warn-soft` |
| `--la-bad-soft` | bad 16% over surface-1 | bad 10% | `bg-bad-soft` |
| `--la-neutral-soft` | `var(--la-surface-3)` | `var(--la-surface-3)` | `bg-neutral-soft` |
| `--la-on-warn` | `#121016` | `#ffffff` | `text-on-warn` |

`bg-accent-tint` already is the accent's soft solid. Contrast test additions: `text` on each `*-soft` token, `on-warn` on `warn`, `on-second` on `second`, `on-accent` on `accent-fill`, at 4.5:1 in all 10 themes. If light-mode `warn` (#8a4b08) fails with white, darken only `--la-warn` in light mode and say so in the PR.

Add to `landing-look.css`, next to `btn-pop`:
- `.btn-layer`: `background: var(--la-surface-3)`, no border, `box-shadow: 3px 3px 0 var(--layer-shadow, var(--la-second))`; on hover translate(-1px,-1px) and shadow 4px 4px; pressed translate(1px,1px) and shadow 1px 1px. No movement under reduced motion (shadow stays).
- `.today-line`: the kept neon. Accent mono capitals between two 1px accent lines with `box-shadow: 0 0 6px color-mix(in oklab, var(--la-accent) 70%, transparent)` on the lines. No band fill and no border-y.
- `.hatch`: `repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, currentColor 14%, transparent) 4px 6px)` for "not certain" fills (Inferred, upcoming bars) now that dashed borders are gone.

## Shared components (`src/components/ui/`)

**`Pill`** (all tones lose `border`):
- `neutral`: `bg-neutral-soft text-text-muted`
- `accent`: `bg-accent-tint text-text`
- `good`: `bg-good-soft text-text`, icon `text-good`
- `warn`: `bg-warn-soft text-text`, icon `text-warn`
- `info`: `bg-neutral-soft text-text`
- `highlight` → billing look: `bg-second text-on-second font-mono uppercase tracking-[0.1em] text-[10px] rounded-[3px]`. Used for Headliner (`LineupTable`, `EventDetail`) and `ArtistsView`. `GenreStory` uses it for anniversaries ("5 years of house"); move those to `accent` since they are not billing.
- `inferred`: `bg-neutral-soft hatch text-text-muted italic` (the "Inferred" label must stay visibly different; the hatch replaces the dashed border).
- Accept an `icon` prop colour per tone so the icon carries the colour (check `ArtistsView.tsx:294` which passes a raw class string as `tone`; give it a proper `bad`/favourite tone: `bg-bad-soft text-text`, heart `text-bad`).

**`HintPill`**: same shape, no border. `needs` → `bg-warn-soft text-text`, icon `text-warn`. `done` → `bg-good-soft text-text`, icon `text-good`. `busy` → `bg-accent-tint text-text`, icon `text-accent`. `info` → `bg-neutral-soft text-text-muted`.

**`Notice`**: card `rounded-card border border-line bg-surface-2 text-text`. The icon sits in a 22px `rounded-[6px]` tile with a solid fill and dark icon: `info` accent-fill, `success` good, `warning` warn, and a new **`error`** tone with bad. Text is always `text-text`.

**`Button`** `danger` variant: `bg-bad-soft text-text` with the icon `text-bad`, no border; hover deepens to `color-mix(in oklab, var(--la-bad) 26%, var(--la-surface-1))`. `Confirm` keeps using it.

**Count bubble**: a small shared piece (in `Pill.tsx` as `CountBubble`, or a new `ui/CountBubble.tsx`): `min-w-[18px] h-[18px] rounded-full font-mono text-[11px] font-semibold tabular-nums`, tones `solid` (`bg-accent-fill text-on-accent`) and `soft` (`bg-neutral-soft text-text-muted`).

## Screens

### Table and Timeline
- **Today band** (`TableView.tsx` `TodayIndicator`, `timeline/AgendaView.tsx`): use `.today-line`. This is the page's neon.
- **"N to confirm"** (`TableView.tsx` shortcut, `timeline/TimelineTab.tsx` dashed pill): solid ink, `bg-warn text-on-warn font-semibold`, alert icon, no border, rounded-full.
- **"Did you go?" on rows** (`HintPill needs` via `timeline/parts.tsx` `ConfirmMark`, `EventsHome.tsx`): picked up from `HintPill`. Keep the amber row edge.
- **Other shortcuts** ("N upcoming", "didn't go, hidden"): `bg-neutral-soft text-text-muted`, no border.
- **Filters button** (`ui/FilterControls.tsx` `FilterButton`): closed stays a secondary button. Open: `bg-accent-tint text-text`, no border, and the count moves into a solid `CountBubble` ("Filters [2]") instead of "(2)".
- **Fill gaps** (`TableView.tsx` `fillButton`): `btn-pop btn-layer`, text `text-text`, sparkles icon `text-second`.
- **Active filter chips** (`TableView.tsx` chip row): `bg-accent-tint text-text`, × icon `text-accent`, no border; hover `bg-row-hover`.
- **Yes/no filter toggles** (`FilterControls.tsx` `YesNoChip`): any → `bg-neutral-soft text-text-muted`; yes → `bg-good-soft text-text` + check `text-good`; no → `bg-warn-soft text-text` + minus `text-warn`. No border in any state.
- **Month view bars** (`timeline/MonthView.tsx` `SEGMENT_STYLE`): `upcoming` → `bg-accent-tint hatch`, text `text-text`; `confirm` → `bg-warn-soft hatch`, text `text-text`. No dashed borders. `went` unchanged.

### Event detail and header
- **Side-list gap counts** (`ui/DetailShell.tsx`): soft `CountBubble` (grey disc, muted number). No amber ring.
- **"Counted"** (`HeroBar.tsx` `went` hint): soft solid good via `HintPill done`.
- **"All filled in"** (`PosterHeader.tsx` `ThingsLeft`): a small `PostIt` (tone paper, no tilt-in animation on every render) with a green check (`text-good` in light ink contrast; use `#0b7a5c` via `--la-good` light value if needed).
- **Offers "+ name as role?"** (`EventDetail.tsx` suggestion chips): `bg-neutral-soft text-text`, plus icon `text-accent`, no border; hover `bg-accent-tint`.
- **Add "+" box** (`EventDetail.tsx` add-act trigger): no coloured border on hover; hover fill `bg-accent-tint`, icon `text-text`.
- **Tips "?" when on** (`ui/TipsContext.tsx`): solid ink, `bg-accent-fill text-on-accent`, no border. Off state unchanged.
- **WENT stamp** (`ui/Ticket.tsx`): unchanged. This is the page's neon.

### Manage, Fill gaps, imports and messages
- **Choice chips with a picked state** (`FillGaps.tsx` gap picker and set-time choices, `CanonicalArchive.tsx` toggles at the `border-accent bg-accent-tint text-accent` sites, `MergeEditionModal.tsx`, `ListImport.tsx` keep/leave-out, `ArtistGenresEditor.tsx` picked genres): picked → `bg-accent-tint text-text` (like a picked `Segmented` choice); not picked → `bg-neutral-soft text-text-muted hover:text-text`. No border in either state. Where a row of one-of-several choices exists, prefer `Segmented` (rule 46.2).
- **Small offer chips** (`FillGaps.tsx` rounded-full suggestions, `ManageEntry.tsx` link chip, `ArtistGenresEditor.tsx` genre tag): soft solid as Offers above.
- **Outlined action buttons** (`FillGaps.tsx` "Find lineups", `EditionNameGaps.tsx`, `SeriesPanel.tsx`, `SeriesHealth.tsx`, `DataHealth.tsx`, `EventDetail.tsx` "Check details"-style outline buttons, `CanonicalArchive.tsx` hover-accent buttons): the shared `Button variant="secondary"` (keeps its neutral border; no accent text). Count buttons (`VenueFillPanel.tsx`, `SeriesCleanupPanel.tsx`) become a secondary `Button` with a solid `CountBubble`.
- **Error, saved and warning boxes**: replace every inline `border-bad/45 bg-bad/10 … text-bad`, `border-good/45 bg-good/10 … text-good`, `border-warn/45 bg-warn/10 … text-warn` box with `Notice` (`error`, `success`, `warning`). Sites: `ManageView.tsx`, `ManageEntry.tsx`, `CanonicalArtistEntry.tsx`, `SeriesPanel.tsx`, `SeriesHealth.tsx`, `DataHealth.tsx`, `SheetSync.tsx` (2), `ListImport.tsx` (2), `ImportReview.tsx` (2), `FillGaps.tsx`, `EventDetail.tsx`, `SharePanel.tsx`, `LineupProgress.tsx`, and the one at `src/App.tsx`. Wording does not change.
- **Destructive outline buttons** (`AccountPanel.tsx`, `MembersPanel.tsx`): `Button variant="danger"`.

## Guard test

Extend `tests/designSystemDrift.test.ts`: scan `src/**/*.tsx` string literals; fail when one string has both a coloured border (`border-(accent|accent-tint-line|good|warn|bad|second)…`) and text in the same colour (`text-(accent|good|warn|bad|second)`), except an allowlist of exactly `src/components/ui/Ticket.tsx` (WENT stamp). Also fail when `Pill.tsx` or `HintPill.tsx` contain the word `border`. The message names the file and line and points to this spec.

## Docs in the same change

- `docs/design-system/design-system.json`: the new tokens, the `Pill`/`HintPill`/`Notice`/`CountBubble` looks, `btn-layer`, `today-line`, `hatch`.
- `docs/design-system/agent-rules.md`: rules 1 to 4 above.
- `docs/specs/landing-look.md`: one row for "Soft solid and no neon" pointing here.
- `AGENTS.md` design-system bullet: add "soft solid pills/chips with no hairlines; at most two neon pieces per page (`docs/specs/neon-cleanup.md`)", within the 6500-character budget test.
- `docs/README.md`: list this spec.

## Slices

Each slice is `[UI / VISUAL]` (typecheck, lint and tests; take a before/after screenshot of the touched screen from `/demo`). One pull request per slice. Do them in order: 51.2 to 51.7 depend on 51.1.

- **51.1 Tokens and shared looks.** `tokens.css`, `landing-look.css`, `tests/themeContrast.test.ts`, `docs/design-system/design-system.json`, `docs/design-system/agent-rules.md`.
- **51.2 Shared components.** `Pill.tsx` (plus `CountBubble`), `HintPill.tsx`, `Notice.tsx` (error tone), `Button.tsx` (danger), `GenreStory.tsx` (anniversaries to accent).
- **51.3 Table and Timeline.** `TableView.tsx`, `ui/FilterControls.tsx`, `timeline/TimelineTab.tsx`, `timeline/AgendaView.tsx`, `timeline/MonthView.tsx`.
- **51.4 Event detail and header.** `EventDetail.tsx`, `ui/DetailShell.tsx`, `PosterHeader.tsx`, `ui/TipsContext.tsx`, `ArtistsView.tsx`.
- **51.5 Manage and Fill gaps controls.** `FillGaps.tsx`, `CanonicalArchive.tsx`, `VenueFillPanel.tsx`, `SeriesCleanupPanel.tsx`, `EditionNameGaps.tsx`.
- **51.6 More Manage and import controls.** `SeriesPanel.tsx`, `SeriesHealth.tsx`, `DataHealth.tsx`, `ManageEntry.tsx`, `ArtistGenresEditor.tsx`, `MergeEditionModal.tsx`, `ListImport.tsx`.
- **51.7 Messages to Notice.** `ManageView.tsx`, `CanonicalArtistEntry.tsx`, `SheetSync.tsx`, `ImportReview.tsx`, `SharePanel.tsx`, `LineupProgress.tsx`, `AccountPanel.tsx`, `MembersPanel.tsx`, `App.tsx` (plus the message boxes in files already touched by 51.5 and 51.6, done there).
- **51.8 Guard test and docs.** `tests/designSystemDrift.test.ts`, `AGENTS.md`, `docs/specs/landing-look.md`, `docs/README.md`, `ARCHITECTURE.md` only if it lists UI looks.

## Not in scope

Ticket stub styles, the post-it component, poster headings, `Segmented`, table and card borders, `Button` primary and secondary looks, any wording change, any data or server change.
