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

## Open

10. A member taps "Verify" on an Inferred value on their own event. Today a member's tick never verifies anything (auto-verify spec). Recommendation: the tap lifts the value on the shared edition to Candidate (with source "your entry"), and two or more members agreeing, or a trusted source, or the owner, makes it Verified.

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
- Auto-verify: "Ticks never verify an act" (item 10, once answered).
- On-screen text that says the app never guesses (landing page `FeatureTiles.tsx`, Find the lineup help in `EventDetail.tsx`) changes when the label ships, not before.

## Proposed slices (to be confirmed before building)

1. Storage: an `inferences` record with the fields above and links between them (migration; held until Charlie applies it).
2. Display: the "Inferred" label, dotted style and reason popover (shared `Pill`), plus a Fill gaps view to confirm or reject inferred values.
3. Code rules on shared editions: first candidates are the venue's most-used place and a month-only event's date range.
4. Reader inferences from fetched pages, with quote and reason.
5. Inferred lineup acts and billing roles.
6. Healing: a verified source replaces an inference and re-checks everything linked to it.
