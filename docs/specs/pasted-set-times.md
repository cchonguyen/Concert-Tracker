# Paste set times from a page (spec)

Status: approved 2026-11-24 (PR #657). Thread: "Get Together As One lineup and set times".
Discovery notes: `/mnt/project-files/together-as-one/scope.md` (project files).

## Ask

Get the lineup and set times for Together As One (WAMU Theater, Seattle, 31 Dec 2024) into the app, and do it in a
way that works for other events whose set times exist only on a site the app may not fetch.

## Decision (Charlie, 2026-11-24)

Festival Dust has the full schedule, but its terms of use forbid bots, scrapers and automated access. Charlie chose
"You paste, the app reads it": he copies a set-times page into the app, code reads the names and times, and the paste
plus its link is stored as the source. The app never fetches the site itself (same stance as AXS).

| # | Question | Answer (Charlie, 2026-11-24) |
|---|----------|--------|
| 1 | Do pasted acts count as a verified source for the shared edition? | Yes, verified, like a lineup page the app fetched. |
| 2 | Who can paste? | Only the owner at first. Members later. |

## How it works today (main at a536a83)

- Set times live on a source: `CandidateSource.sets` (`SetTime`: day, stage, start, end in
  `src/server/lineup/types.ts`), shown by `src/server/events/sets.ts`. Only Clashfinder fills them today.
- A lineup lookup (`src/server/lineup/pipeline.ts`) runs every adapter, then the review and confirm flow
  (`docs/architecture/09-lookup-pipeline.md`) writes the shared edition and the person's seen acts.
- For this event: the shared edition `together-as-one/2024-12-31` has no acts, the series has no lineup page, and the
  lookup started 2026-11-24 found nothing and is paused on the Brave Search monthly limit until about 1 Dec.
- The official page (pnw.togetherasonenye.com) lists 22 acts as text, with no times. It can be saved as the series'
  lineup page in Global Archive > series editor, where the existing promoter adapter reads it (Wayback copy of
  31 Dec 2024).

## What a paste looks like

Festival Dust, copied from the browser (trimmed):

```
Together As One 2024 Set Times & Schedule
Dec 31st - Dec 31st · Seattle, WA
Day 1
6 pm
...
Peace
Love
Unity
ARMAND VAN HELDEN
9:30pm - 10:45pm
AZZECCA
8:15pm - 9:30pm
...
```

The stage names appear once, at the top. Nothing in the text says which act is on which stage (the groups are only
alphabetical runs), so stages stay missing. Guessing them from the alphabetical breaks would be inference.

## The rules

1. **Paste, never fetch.** The person pastes the text and gives the page's link. The app stores the paste as a source
   document (`sourceType: 'pasted'`, the link as its URL, the text as its content) and never requests the link.
2. **Read in code only.** `parsePastedSets` reads a name line followed by a time line (`9:30pm - 10:45pm`,
   `12am - 2am`, `21:30–22:45`). No model call. Lines it cannot pair are shown to the person as "not read" and are
   dropped.
3. **Verbatim.** Each act's quoted span is its name line plus its time line, exactly as pasted. `isVerbatim` is
   unchanged.
4. **Dates come from the event.** A paste's own dates are ignored. On a one-day event every set is on the event's
   date; a set starting before 06:00 is placed on the next calendar day, with `day` kept as the event's date (the
   rule Clashfinder already uses). On a multi-day event, times are read only under a heading that names a date or a
   weekday inside the event's dates; otherwise acts are added with no time.
5. **Stage only when the text says it.** A stage is kept only when a line naming it comes directly before that act's
   group (for example "Peace" then its acts). Festival Dust's layout gives no stages.
6. **Review as usual.** A paste opens the normal lineup review with the pasted acts. Nothing is added to seen acts
   without a tap. Names already on the lineup are matched (`normalizeName`), so the paste adds times to them.
7. **No quota, no web search.** A paste runs only the pasted source: no Gemini, no Brave, no other adapters, so it is
   never parked on a limit.
8. **Trust.** A paste with its link is a trusted source for auto-verify: an act it lists, on an edition whose date it matches, is `verified` (the auto-verify rule is widened in slice 1).
9. **Owner only.** The paste route refuses members until Charlie widens it.

## Slices

| # | Tag | What | Files |
|---|-----|------|-------|
| 1 | docs | Rule change first: AGENTS.md set-times and auto-verify lines name a pasted page (owner only) as a trusted source; 08-sources adds `pasted`; 09-lookup-pipeline describes the paste run | `AGENTS.md`, `docs/architecture/08-sources.md`, `docs/architecture/09-lookup-pipeline.md` |
| 2 | CORE | Parser: name and time pairs, day placement, stage headings, "not read" lines | `src/server/lineup/pasted.ts`, `tests/pastedSets.test.ts` |
| 3 | CORE | `pasted` source type, adapter, paste-only lookup run, route `POST /api/lineup/paste` | `src/server/lineup/types.ts`, `src/server/lineup/adapters/pasted.ts`, `src/server/lineup/pipeline.ts`, `src/server/lineup/routes.ts`, `tests/pastedAdapter.test.ts` |
| 4 | UI | Event lineup: "Paste set times" (link + text box, preview of what was read and not read, then review) | `src/components/PasteSetTimes.tsx`, `src/components/EventDetail.tsx`, `src/services/lineupApi.ts` |
| 5 | data | For Together As One: save the official page as the series lineup page, run the lookup, paste Festival Dust, link Charlie's event to the edition. Done in the app by Charlie or the thread, no code | none |

Exact file names in slices 3 and 4 are checked against the code when each slice starts.

## Not in scope

- Fetching Festival Dust or any site whose terms forbid automated access.
- Reading posters or screenshots.
- Guessing stages from list order or layout.
