# LiveArchive design system export

A hand-copied kit that lets a new app built with Claude Code start with LiveArchive's design language and philosophy. It describes what the app does today. It is not a package and has no build step: copy the folder and adapt it.

Source of truth stays in this repo: `src/index.css`, `src/services/theme.ts`, `src/components/ui/`, [REQUIREMENTS.md](../../REQUIREMENTS.md) section 3, [AGENTS.md](../../AGENTS.md) "Design system" and [15-shared-ui.md](../architecture/15-shared-ui.md). When those change, update this folder in the same change.

## What is in it

| File | For |
| --- | --- |
| [design-system.json](design-system.json) | Machine-readable tokens and the component catalogue: principles, colour and accent scales, light remap, radius, breakpoints, touch targets, motion rules, theme storage keys, components with props, states and accessibility contract. |
| [philosophy-and-voice.md](philosophy-and-voice.md) | Ranked principles, their UI consequences, and voice and copy rules with real strings from the app. |
| [agent-rules.md](agent-rules.md) | Design rules to paste into the new repo's `AGENTS.md` or `CLAUDE.md`. |

## Stack it assumes

React with TypeScript, Tailwind CSS v4 (CSS-first, `@import "tailwindcss"` and `@theme`), and `lucide-react` icons. The tokens are plain CSS variables, so another stack can read them, but the components are React.

## Onboarding checklist for a new Claude Code repo

1. Copy `docs/design-system/` into the new repo at the same path.
2. Paste the rules block from [agent-rules.md](agent-rules.md) into the new repo's `AGENTS.md` (create it if missing), and add `@AGENTS.md` to `CLAUDE.md` so Claude Code loads it.
3. Write the new app's own ranked principles in its requirements doc. Start from [philosophy-and-voice.md](philosophy-and-voice.md) and keep the ones that fit; reorder them for the new product.
4. Apply the tokens: copy the theme blocks of LiveArchive's `src/index.css` (accent scales, the violet-to-accent mapping, the `[data-theme='light']` remap, the `@theme` radius block) into the new app's main stylesheet. Write UI in Tailwind's `zinc` and `violet` classes so the themes work.
5. Copy `src/services/theme.ts` and the pre-paint script from LiveArchive's `app.html` (it sets `data-theme` and `data-accent` on `<html>` before the app draws). Rename the `livearchive.*` storage keys to the new app's prefix in both places.
6. Copy only the components from `src/components/ui/` that the first screen needs (start with `Button`, `IconButton`, `Tooltip`, `Notice`, and `PosterHeading` for titles). Add others when a change needs them. For the landing look also copy `src/styles/landing-look.css` (imported by the main stylesheet), `AppBackdrop`, `Logo` and `PostIt`; for ticket stubs, `Ticket`, `StubHeader` and `src/styles/ticket-styles.css`.
7. Check each copied component keeps its accessibility contract from `design-system.json` (`a11y`), then run the new repo's typecheck.
8. Read the voice rules before writing the first empty state, error or toast.

## Not defined yet

LiveArchive has no tokens for these. Use Tailwind defaults and do not invent named tokens until the new app needs them:

- Typography: no type scale. Font roles are tokens in `src/index.css` (`--font-sans`, `--font-display`, `--font-mono`, and `--font-poster` for capitals poster headings, `docs/specs/landing-look.md`); sizes are Tailwind's defaults.
- Spacing: no spacing tokens. Tailwind's default scale.
- Motion: one easing token, `--ease-pop` (buttons and post-its, `src/styles/landing-look.css`). Other durations are inline per component (listed in `design-system.json` under `motion.used`).
- Shadows and z-index: inline Tailwind classes, no scale.
- Elevation of named surfaces beyond the `zinc` steps.
