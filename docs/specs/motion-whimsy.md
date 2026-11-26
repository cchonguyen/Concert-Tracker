# Motion with a little whimsy

Charlie's request, 2026-11-25: "I would like to see more animations like these on rows, buttons, tabs, etc. It adds a slight sense of whimsy to the app without being too obnoxious or taking away from visibility/usability. In general, I'm having trouble seeing the animations or motion effects you've put in so far. They're all very subtle and hard to see."

Status: round 1 built in Slice 30.5. It raises the motion of `docs/specs/design-refresh-2.md`, section 4, which was too faint to notice.

## Rules

- Motion is quick (under half a second, except fades that trail off) and never hides content or delays a tap.
- Everything stops under reduced motion (the global rule at the end of `src/index.css`, and `useReducedMotion` in motion components).
- Hover effects apply only where a pointer can hover.

## What moves

- **Every control** (`button`, links, inputs, `role="button"`) fades colour, border and shadow changes over 160 ms instead of snapping (`@layer base` in `index.css`, so Tailwind utilities still win).
- **Press:** any button squashes to 94% while pressed and springs back. Full-width rows (`row-hover`) only tint.
- **Rows:** the shared hover tint with its fade-out trail (`docs/specs/row-hover.md`).
- **Icon buttons:** the icon tips and grows on hover (`icon-wiggle`, on `IconButton`).
- **Tabs and segmented choices:** the tab mark and the chosen fill in `Segmented` slide to the new choice with a small overshoot.
- **Popovers and menus** (`Popover`, `MenuButton`, the header menu) pop in from their trigger (`pop-in`).
- **Saved fields** glow green and settle over about a second (`save-flash`), as well as the green ring and tick.
- **Toasts** spring up and sink away as they fade.
- **Star rating:** the chosen star and those before it pop in a quick ripple.
- **Burst** ("Yes, I went", favourite set): eight marks fly out from the middle and fade, instead of pulsing in place.
- **A just-added ledger row** slides in from further up with a bounce and glows for 2.4 s.

## Next ideas (not built)

Cards easing in when the detail opens, a number tick on counts, and a gentle shake on a failed save.
