# Who I Saw fills the lineup; simpler concert lineups

Status: approved by Charlie 2026-11-28 (thread "Fill concert lineups from Who I Saw": 1B, tap-to-add name suggestion, catch-up yes).

## Why

On 2026-11-28, 339 of 430 events (79%) had no shared edition, so their lineup panel could never show anything. 51 of them had Who I Saw acts. Linked events copy Who I Saw acts into the edition as candidates (`src/server/canon/memberTick.ts`), but the hourly contribute pass (`contributeBack`, `src/server/canon/autoLink.ts`) reached about one event an hour, leaving 64 linked events waiting.

## Rules kept

- Who I Saw acts join the shared lineup only as `candidate` acts sourced "your entry". One person's tick never verifies (`docs/auto-verify-spec.md`).
- A draft edition is the same `provisional` shape a member entry already creates (`persistOwnEntry`, `src/server/events/details.ts`): typed name, full YYYY-MM-DD start date, and venue, city and state only when typed. No personal field, user id or event id goes into it.
- Nothing is filled from the event name without a tap. The name only gives one-tap suggestions (`/api/events/:id/name-artists`).

## Slice 52.1: Draft edition for unlinked events with Who I Saw acts

- New `ensureDraftEdition(store, event, now)` in `src/server/canon/draftEdition.ts`. Only for an event with no `editionId`, a non-empty name and a full start date (Charlie 2026-11-28: grow shared editions for every user, not only events with Who I Saw acts). Members are included only when their entries may already feed shared editions (the same notice gate as `persistOwnEntry` and `memberBackfill.ts`). It calls `upsertOccurrence` (trust `provisional`, actor `member:entry`, reason "Member entry", typed fields as in `persistOwnEntry`). On `created`, `updated` or `unchanged` it links the event with `linkedToEdition` and records `details.autoLinked` with reason "Draft edition from your Who I Saw", so Unlink undoes it. `ambiguous` and `skipped_no_date` leave the event as it is.
- `PATCH /api/events/:id` with `seen` on an unlinked event runs it, saves the link, then `recordWhoISawTicks`. A failure never fails the save.
- The auto-link pass runs `ensureDraftEdition` for unlinked dated events that matched no verified edition (events with Who I Saw acts first), then `contributeBack`, within the same subrequest budget.
- Catch-up: the auto-link pass runs at minutes 3 and 4 of every 5 (minute % 5 >= 3) instead of hourly, so the waiting events are reached in hours rather than days. Each member contributes waiting linked events first, then drafts, then contributes the new links. It returns early when nothing is waiting.
- Events without a full date stay unlinked until a date is added.

## Slice 52.2: Concerts hide Stage and Set times

- `LineupTable` takes `concert`. For a concert (`eventScale(...).kind === 'concert'`) the Stage and Set times columns and the "Set times and stages come only from timed sources" note are hidden, unless an act has a set time or stage (for example from pasted set times).

## Slice 52.3: "+ Add" for concerts

- For a concert, the lineup card shows "+ Add" in place of "Find the lineup". Typing a name (with past-artist suggestions, `SuggestInput`) adds the act to Who I Saw (`from: 'you'`), which reaches the lineup through slice 52.1.
- Name suggestions from `/api/events/:id/name-artists` show as one-tap chips: "Add Zedd?".
- The full lookup stays as a small "Look it up" link. Festivals keep "Find the lineup" as now.
