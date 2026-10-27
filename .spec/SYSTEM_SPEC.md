# System Specification & Contracts

The full spec already lives in the project docs. This file holds only what `/triage` and the `architect` subagent add for the feature in progress; it must not contradict them.

- Requirements and ranked principles: [REQUIREMENTS.md](../REQUIREMENTS.md)
- Architecture, data model and module boundaries: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Hard rules for every change: [AGENTS.md](../AGENTS.md)

## 1. Core Scope & MVP Boundaries
Feature: **theme picker** (triaged 2026-10-27, not started).

What exists today:
- The app is dark only. Colors are about 940 hardcoded Tailwind classes across `src/App.tsx` and 15 components, built on two scales: `zinc` (surfaces and text) and `violet` (accent), plus `amber`, `rose` and `emerald` for status.
- A few colors live outside Tailwind: map markers and the tour line in `src/components/MapView.tsx` (hex), the dark tile filter and Leaflet background in `src/index.css`, and `<meta name="theme-color">` in `index.html`.
- Per-device view preferences already use `localStorage` (Artists view mode and sort in `src/components/ArtistsView.tsx`). There is no settings screen.

Approach (recommended): **remap Tailwind's own color variables per theme.** Tailwind v4 compiles `bg-zinc-900` to `var(--color-zinc-900)`, so a `[data-theme="..."]` block in `src/index.css` that redefines `--color-violet-*` (and, for a light theme, `--color-zinc-*`) recolors the whole app without touching component classes.

MVP:
1. Accent themes: 4 to 6 named palettes that swap the `violet` scale (for example Violet, Emerald, Rose, Sky, Amber). Dark surfaces stay.
2. Picker: a small palette button in the header next to the tab bar, opening a row of swatches. Choice saved in `localStorage` per device and applied as `data-theme` on `<html>`.
3. No flash: a tiny inline script in `index.html` sets `data-theme` before React loads.
4. Non-Tailwind colors read the CSS variables: map markers via `getComputedStyle`, and `theme-color` meta updated on change.

Phase 2 (only if wanted): a **light mode** (plus "Match system"), done by inverting the `zinc` scale and shifting accent shades (`violet-300` text becomes dark on light). Needs a pass over every view for contrast, the map tile filter turned off, and `text-white` on accent buttons checked. If remapping proves too blunt, the fallback is semantic tokens (`bg-surface`, `text-muted`, `accent`) introduced view by view.

Open choice for Charlie: accent colors only, or a light mode too. Stored per device or synced across devices (would need a Supabase settings row and a migration).

## 2. Strictly Out of Scope ("Do NOT Build" List)
- Anything AGENTS.md forbids (guessed data, hardcoded festival/venue/artist lists, model calls in parsing or saving, demo data, AXS scraping).
- Theme picker: no per-component color rewrites in the MVP; no user-built custom colors or color wheel; no theme field on capture or on events; no new dependency (no theme library); no change to status colors (amber, rose, emerald) meaning; no server or database change unless cross-device sync is chosen.

## 3. Data Models & Module Boundaries
- See ARCHITECTURE.md. Add feature-specific contracts here.
