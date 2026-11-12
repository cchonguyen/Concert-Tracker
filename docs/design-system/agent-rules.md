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
- Write UI in Tailwind zinc (surfaces, text) and violet (accent) classes. Themes remap those variables; do not hardcode hex colours in components.
- Use rounded-control for buttons, inputs and icon buttons, and rounded-card for cards, panels and notices.
- Theme mode and accent are per-device choices in localStorage (<prefix>.themeMode.v1, <prefix>.accent.v1), applied to <html> as data-theme and data-accent before the app draws. Keep the pre-paint script and the theme module in step.
- Do not invent typography, spacing or motion tokens. Add one only when a change needs it, and add it to design-system.json in the same change.

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
