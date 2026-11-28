# Agent rules to paste

Copy the block below into the new repo's `AGENTS.md` (and reference it from `CLAUDE.md` with `@AGENTS.md`). It generalises LiveArchive's design rules; the domain rules (lineups, sources, models) are left out. Replace `<prefix>` with the new app's storage prefix.

```markdown
## Design system

Read docs/design-system/README.md, philosophy-and-voice.md and design-system.json before changing UI.

### Principles in the interface
- Never synthesize, default or infer a value the person did not give or a source did not state. Missing data stays missing and the UI says so ("Not known yet", "No date yet").
- Your word wins: suggestions never overwrite what the person typed. A suggestion applies only when they tap it or when it exactly confirms what they entered.
- Suggestions are one-tap offers. Nothing is added to the person's data without a tap.
- Saving never waits on a network call, research or a slow step. Slow work starts only when asked for, on something already saved.
- Keep the entry point to one line of input. New fields go on the detail view, not the entry form.
- No demo or seeded data in the real app. An empty app is empty and says how to start.
- Reversible actions act at once and offer Undo in a toast. Only irreversible actions use a Confirm dialog, whose button names the action (never "OK").

### Components
- Shared UI components live in src/components/ui/. Use them for new UI.
- When you touch a component that has its own inline copy of a shared pattern (a dropdown, a tooltip, an icon-only button, a pill, a back-to-top), move it onto the shared component in the same change. Do not build a fresh copy.
- Only add a shared component when the current change needs it. Do not build the whole library ahead of use.

### Tokens and theme
- Write new UI using semantic `--la-*` utilities (`bg-surface-1`, `text-text-muted`, `border-line`, `bg-accent-fill`, `text-on-accent`, `text-good/warn/bad`). Themes remap those variables; do not hardcode hex colours in components. Legacy `zinc` and `violet` classes remain mapped for older screens.
- Use rounded-control for buttons, inputs and icon buttons, and rounded-card for cards, panels and notices.
- Theme mode and accent are per-device choices in localStorage (<prefix>.themeMode.v1, <prefix>.accent.v1), applied to <html> as data-theme and data-accent before the app draws. Keep the pre-paint script and the theme module in step.
- Type roles: font-sans for what people read or tap, font-display for names of things, font-mono for dates, times, counts and prices, and PosterHeading (font-poster, capitals) for page, section, panel and dialog titles. Never set a name of a thing in poster capitals.
- The second colour (text-second, bg-second, bg-second-soft) is for emphasis, tape, stamps and highlights, never for status. Every accent needs its partner in dark and light.
- Motion uses --ease-pop: buttons lift and grow a little, never tilt; post-its straighten and lift. Everything stops under reduced motion.
- Callouts and highlights use PostIt; the page background is AppBackdrop, mounted once; the logo is Logo, never a bare img.
- Ticket styles are tokens only: a new style is one block in the ticket-styles module plus one list entry, never component changes.
- Do not invent other typography, spacing or motion tokens. Add one only when a change needs it, and add it to design-system.json in the same change.

### Soft solid, no neon
Full rules and the look-by-job table: docs/specs/neon-cleanup.md.
- At most two neon pieces per page: the Today line (`.today-line`) and a ticket's WENT stamp. New neon needs a spec line saying which piece it replaces.
- No hairline strokes on pills, chips, badges, tags, toggle chips or count bubbles. They are filled shapes with no border. Hairlines stay on tables and rows, cards and panels, inputs, the Segmented frame, dividers and buttons.
- Text on a tinted fill is ink (`text-text`), not the tint's colour. Colour lives in the fill and in the icon.
- Pick the look by job: one thing that needs you is solid ink (`bg-warn text-on-warn`); anything repeated per row is soft solid (`bg-good-soft`, `bg-warn-soft`, `bg-bad-soft`, `bg-neutral-soft`, `bg-accent-tint`); a signature action is layered (`btn-layer`); a done or empty moment is a PostIt; billing is solid second colour in mono capitals; messages are a Notice card.

### Accessibility
- Every icon-only control has a required label, used as its aria-label and its tooltip.
- Touch targets are at least 44 px on phones (36 px from the sm breakpoint up); dismiss buttons are 40 px.
- State is never shown by colour alone: pair it with a word, tick or icon.
- Dialogs and sheets move focus inside, trap Tab, close on Escape, and return focus to the opener.
- Respect prefers-reduced-motion: celebrations do not run at all, and transitions turn off.
- Wrap every localStorage read and write in try/catch; the UI must work without it.

### Voice
- Warm and inviting, never obsequious or cloying. Speak to the person as "you".
- Ask when something is missing ("When was it?"). Say plainly when something is absent, without apology.
- Errors say what failed and offer the retry ("Couldn't save · Try again"). No "Oops" or "Sorry".
- Exclamation marks only for earned milestones.

### Docs
- Update docs/design-system/ in the same change when a token, shared component or rule above changes.
```
