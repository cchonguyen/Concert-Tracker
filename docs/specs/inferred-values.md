# Inferred values (spec)

Status: principle approved 2026-11-24 (Charlie, thread "Reword never guess core principle"). Build not started. The behavior rules in AGENTS.md that this changes stay in force until the slice that changes each one is built.

## Ask

Replace "never guess" with "always verify, and label every inference". The old rule was too rigid: fetch fixes were blocked because any value without a direct verified source was refused, even when the app's own data or a fetched page gave a strong, explainable reason. Made-up values (a model answering from memory, a value with no reason anyone can check) stay forbidden.

## Decisions (Charlie, 2026-11-24)

| # | Question | Answer |
|---|----------|--------|
| 1 | Why change? | The rule blocked fetch fixes and caused conflicting-rule back-and-forth with building agents. Confidence can be tracked over time and values re-checked. |
| 2 | Where is the line between inference and made-up data? | An inference must have a reason that can be argued for or against: named inputs and logic that gives the same answer each time. No clear reason means it is not stored. |
| 3 | Can inferences build on inferences? | Only inside the Inferred level, and each one is linked to what it was built from, so a better source later fixes every dependent value at once. Inferred values never enter verified data and never help make anything Verified. |
| 4 | How are they shown? | Labelled everywhere, at least with an icon, faded colour or dotted border. |
| 5 | Can an inference fill an empty field on its own? | Yes, only an empty field. It is a placeholder, not better data: it waits for a person to tap "Verify" or a source to replace it. It never overwrites a typed or verified value. |
| 6 | Personal events or shared editions? | Shared editions first. Members start from a better edition; inferring on each personal event is wasteful. |
| 7 | Can the reader model (AI) infer? | Yes, only from pages the app fetched, never from memory, with the quoted text and a one-line reason. This is the main fetch improvement. |
| 8 | Lineups? | An act or a billing role (for example a headliner from poster order) may be Inferred, shown dotted. Who you saw still needs your own tap. |
| 9 | Name? | "Inferred" (not "Guess"). It ranks below Candidate. |

| 10 | A member taps "Verify" on an Inferred value on their own event? | The value on the shared edition is lifted to Candidate (source "your entry"). It becomes Verified when two or more members agree, a trusted source confirms it, or the owner confirms it. (Changes the auto-verify rule "Ticks never verify an act" in the slice that builds it.) |

## Rules for an inferred value

- Stored as its own record: field, value, a one-line reason in plain words, the inputs it used (source documents, quoted spans, or the ids of other values), and who made it (code rule name or reader call id).
- Shown with the "Inferred" label and the dotted style, with the reason on tap.
- Never overwrites a value you typed or a verified value. A verified source replaces it, and every inference linked to it is re-checked or removed in the same change.
- Never counts toward an edition becoming verified, and never feeds an inference outside the Inferred level.
- Changes to a shared edition go through `writeEdition` with a system actor and reason, are logged in `edition_changes` and can be undone, as today.
- Shared records still never hold personal fields.

## AGENTS.md rules each build slice will change

- "Never synthesize, default or infer a lineup, date, ..." (reworded now to allow labelled inferences under this spec).
- Billing role: "List order, font size or position never make a headliner" (slice for item 8).
- Reader model: "never asked for ... dates it was not shown" and the extraction-only prompt in `src/server/lineup/gemini.ts` (slice for item 7). "Never answers from memory" stays.
- Venue fill: "several places are only offered" (could become an Inferred pick of the most-used place).
- Auto-verify: "Ticks never verify an act" (item 10: two or more members agreeing will verify). Two members ticking the same act also verify it (`docs/specs/series-sync.md` Rule 1c).
- On-screen text that says the app never guesses (landing page `FeatureTiles.tsx`, Find the lineup help in `EventDetail.tsx`) changes when the label ships, not before.

## Build plan (Charlie said "start building", 2026-11-25)

Slices 27.1 to 27.7 in `.spec/PROGRESS.md`, one issue and one pull request each. Inferred values live in their own shared table, never in the edition's own columns, so verified data stays clean. A shown value is the edition's own value, else its active inference.

### Storage (27.1)

Migration `0055_edition_inferences.sql` (held until Charlie applies it):

| Column | Meaning |
|---|---|
| `id` uuid | primary key |
| `edition_id` text | the shared edition (`event_editions.id`, cascade on delete) |
| `field` text | `startDate`, `endDate`, `venue`, `city`, `region` or `country` (lineup acts come in 27.6) |
| `value` jsonb | the inferred value |
| `reason` text | one line in plain words, never empty |
| `rule` text | the code rule's name, or `reader` |
| `inputs` jsonb | what it was built from: `{kind:'source', url, quote}`, `{kind:'record', table, id}` or `{kind:'inference', id}` |
| `parents` uuid[] | the inferences it was built from (the lineage), for healing |
| `status` text | `active`, `confirmed`, `replaced` or `rejected` |
| `actor` text | who or what made it |
| `created_at`, `resolved_at`, `resolved_by`, `resolved_reason` | when made and how it ended |

One `active` inference per edition and field (partial unique index). Row level security on, owner reads only (the Worker serves members). No personal fields.

Store methods (`LineupStore`, file and Supabase): `addEditionInference`, `listEditionInferences(editionId)`, `listInferenceChildren(id)`, `resolveEditionInference(id, {status, by, reason})`.

### Rules (27.2)

`src/server/canon/inferences.ts`:
- `inferEditionField` writes an inference only when the edition's field is empty, the reason is not empty and every parent is an active inference. Each write is recorded through `writeEdition` with a system actor and reason (`after.inferenceAdded`), and undo rejects it.
- `healEdition` runs after a verified or typed value lands on a field. The field's active inference becomes `replaced` (or `confirmed` when the values match), and every inference built on it, directly or further down, is set to `replaced` with the reason "its input was replaced".
- `shownValue` returns `{value, inferred, reason}` for display.

### Slices

| Slice | What | Files |
|---|---|---|
| 27.1 | Storage: migration, types, store methods | migration 0055, `src/server/lineup/types.ts`, `src/server/lineup/store/{types,fileStore,supabaseStore}.ts`, test |
| 27.2 | Rules: record, heal, undo, shown value | `src/server/canon/inferences.ts`, `src/server/canon/editions.ts`, test |
| 27.3 | Display: "Inferred" pill with dotted border and the reason on tap, on event Details for linked events; the inferences API; on-screen "never guesses" text updated | `src/components/ui/Pill.tsx`, `src/components/EventDetail.tsx`, `src/services/lineupApi.ts`, the events routes, `src/components/FeatureTiles.tsx` |
| 27.4 | First code rule: a venue known in several places infers the place most of its editions use, when one place clearly leads. It runs with the owner's Venue fill and is shown as choices too. (The map rule, a city named by several places inferring the biggest, waits for a later slice: it costs a map lookup per edition.) | `src/server/canon/venueFill.ts`, `src/server/entities/routes.ts`, test |
| 27.5 | Reader inferences: deep search may return a field it infers from a fetched page, with its quote and reason (never from memory) | `src/server/events/detailsGemini.ts`, `src/server/canon/inferences.ts`, AGENTS.md reader line, test |
| 27.6 | Inferred lineup acts and billing roles (poster order), dotted in the lineup; who you saw still needs your tap | migration (performances verification gains `inferred`), `src/server/lineup/billing.ts`, `src/server/lineup/gemini.ts`, lineup UI, AGENTS.md billing line |
| 27.7 | Review: an "Inferred" view in Fill gaps to confirm or reject; a member's Verify tap lifts the value to Candidate, and two members agreeing verifies | `src/components/FillGaps.tsx`, `src/server/canon/autoVerify.ts`, routes, AGENTS.md auto-verify line |

Built: 27.1 to 27.7 (27.6 as billing roles only; inferred acts deferred). 27.7 follows the plan Charlie approved 2026-11-25: owner Confirm or Reject in Fill gaps, member Verify taps, two members agreeing verifies (migration 0057). In 27.5, `checkedInferences` and `storeReaderInferences` store reader inferences on the shared edition (see `docs/architecture/12-data-model.md`), and the AGENTS.md reader line is changed.

### 27.6 in detail (proposed 2026-11-25)

Billing roles first. Inferred acts wait until there is a rule that can be argued for, because every stored act still needs a source and a verbatim quote.

- Rule `billing-named-after-act`: a concert edition (not a festival, per `scale.ts`) whose stored lineup source lists 2 or more acts, and whose name is exactly one of those acts after normalization. That act is inferred Headliner and the others inferred Support. Reason: "The event is named after X and the source lists N other acts."
- Never over a role a source stated (`billing.ts` markers), and never on a festival.
- Storage: migration `0056_inferred_billing.sql` lets `edition_inferences.field` be `billing` with a `subject` (the act's key), one active per edition, field and subject. Healing works as for other fields: a stated role replaces or confirms it.
- Display: the role pill in the lineup shows dotted with "Inferred" and the reason on tap. Who you saw still needs your tap.
- AGENTS.md billing line: "List order, font size or position never make a headliner" gains "except as an inferred role under `docs/specs/inferred-values.md`, never a stored one".
