# Row hover: a stronger tint that fades out

Charlie's request, 2026-11-25: "Provide a stronger highlight when hovering over things and animate a fadeout so it's fun to sweep over a bunch of rows."

Status: built in Slice 30.4.

## What it does

- Every hoverable row shares one look, the `row-hover` class in `src/index.css`. The row takes the `--la-row-hover` tint, an accent-tinted lift over `surface-2` (16% accent in dark mode, 9% in light), so it reads clearly in all ten themes.
- The tint comes in almost at once (40 ms) and fades out over 800 ms (slowed from 500 ms on 2026-11-26), so sweeping the pointer down a list leaves a short trail.
- It applies only where a pointer can hover (`@media (hover: hover)`), so touch screens never keep a stuck tint.
- Reduced motion drops the fade (the global reduced-motion rule in `index.css`).
- Faint text is too light on the tint, so a hovered row shows it as muted text. `tests/themeContrast.test.ts` checks text, muted text and accent text on `--la-row-hover` at 4.5:1 in every theme.

## Where it is used

- `ReadRow` (the edition panel and Your night). The desktop edit-icon square is filled with the same tint and fades with the row.
- `Ledger.Row` with `onOpen` (the Table, the agenda and the other ledger lists), plus the ledger rows in CanonicalArchive and ManageView.
- The split view's list of events (`DetailShell`), the lineup table rows (`LineupTable`), Who you saw act rows (`EventDetail`), an artist's event list (`ArtistsView`) and the river timeline's list (`RiverView`).

Buttons, menu items and chips keep their own hover. They are controls, not rows.
