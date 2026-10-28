# System Specification & Contracts

The full spec already lives in the project docs. This file holds only what `/triage` and the `architect` subagent add for the feature in progress; it must not contradict them.

- Requirements and ranked principles: [REQUIREMENTS.md](../REQUIREMENTS.md)
- Architecture, data model and module boundaries: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Hard rules for every change: [AGENTS.md](../AGENTS.md)

## 1. Core Scope & MVP Boundaries
Feature: **theme picker** (triaged 2026-10-27; built 2026-10-28, PR #51). Charlie chose accent colors plus a light mode, saved per device.

- Dark / Light / Match system, plus five accents (Violet default, Indigo, Pink, Teal, Orange), from a palette button in the header (`src/components/ThemePicker.tsx`).
- Saved in `localStorage` (`src/services/theme.ts`); `index.html` applies it before the app draws, so there is no flash.
- `src/index.css` redefines Tailwind's `--color-violet-*` per accent, and in light mode mirrors `zinc` and the light and dark ends of every colored scale (500 to 700 stay, so white text on buttons still reads).
- Map markers and route use CSS classes so they follow the theme; tiles are only darkened in the dark theme.
- Status colors (amber, rose, emerald, sky) keep their meaning; they only get the light-mode mirror.

## 2. Strictly Out of Scope ("Do NOT Build" List)
- Anything AGENTS.md forbids (guessed data, hardcoded festival/venue/artist lists, model calls in parsing or saving, demo data, AXS scraping).
- Theme picker: no per-component color rewrites in the MVP; no user-built custom colors or color wheel; no theme field on capture or on events; no new dependency (no theme library); no change to status colors (amber, rose, emerald) meaning; no server or database change unless cross-device sync is chosen.

## 3. Data Models & Module Boundaries
- See ARCHITECTURE.md. Add feature-specific contracts here.
