# Canonical weather (one record per edition)

> **Archived 2026-11-23.** All five slices built (the last in PRs #512, #514 and #517).

Status: spec, approved by Charlie 2026-11-18 ("Go"). Not built. Migration not applied.

## Decision

- A canonical edition holds one weather record. Everyone who saves an event from that edition gets the same record. Charlie chose per edition over a shared city-day cache: "per edition is enough for us" (2026-11-18). A city-day cache stays a possible later step, not part of this spec.
- A member's own lookup is kept on their event (`logged_events.weather`, unchanged). Nothing about it is shared except through the rule below.

## Data

- `canonical_editions.weather` (jsonb, nullable), same shape as `EventWeather` in `src/server/events/types.ts`: place, latitude, longitude, days (date, high, low, precipitation, code), sourceUrl, checkedAt.
- Shared-table rule: only those fields. No member IDs, companions, notes, rating, price, attendance or links to a member's event.
- Migration: `supabase/migrations/00NN_edition_weather.sql` (number assigned at build time). Written in the build slice; held until Charlie says it is applied.

## Flows

1. **Save from an edition (stage 1).** The event copies `edition.weather` when set. When the edition has none, `lookupWeather` runs once, as today, and its result is stored on the edition and on the event. A failure never fails the save.
2. **Promotion of existing lookups.** When a member links an event to an edition with no weather, and the event's stored weather has the same place and its days fall inside the edition's dates, copy it to the edition. Records flagged `cityChanged` are not copied. The copy is logged as an edition change.
3. **Refresh.** Admin only, on request. Replaces the edition record and logs old value, new value, who and why. Undoable.
4. **Refusals.** Month-only or undated events get no weather and say why. The existing rules still apply: past dates only, a city the geocoder places exactly once.

## Rules that apply (from AGENTS.md)

- Shared edition changes are logged and can be undone.
- A sync never overwrites a newer edit.
- No automatic lookup outside the save-from-edition path.
- Weather is never a canonical lineup, date, venue or city field.

## Slices (to open as issues when started)

1. Schema and store: `edition.weather` read and write, shared-field allow-list, migration (held).
2. Save path: copy the edition's record on save; lookup once per edition when none; tests.
3. Promotion of existing member lookups on link; tests for place match, date window, `cityChanged` exclusion.
4. Admin refresh with edition history and undo; tests.
5. UI: show the edition's record on the event; "Look again" is admin-only on the edition.

## Open items

- Confirm the admin refresh control lives in the Global archive edition view.
- Archive revisions: refresh policy beyond admin-only (none planned).
