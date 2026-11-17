# Audit: how event data is entered, corrected and stored (2026-11-17)

Read-only analysis of the production database (Supabase project `mybwchgqhrpvdczqigma`). No code, data or schema was changed. Counts are aggregates. No personal fields (companions, notes, ratings, ticket prices) and no individual event details are reproduced here.

## Summary

- **Email import is probably the dominant entry path.** About 74% of the 572 personal event rows carry a ticket-price source key, which most likely means a ticket email. The data does not tag the import route directly, so this is an inference. Only 8% are linked to a shared edition.
- **One concrete defect.** 60 active events have calendar-link text (`Add to Google · Outlook · iCal · Yahoo`) stored as their venue. All 60 came from one import batch on 2026-11-02.
- **Dates are the largest gap.** 220 of 572 rows (38%) have a year but no start date. The year-only queue is never researched automatically.
- **Deletion is high.** 144 of 572 rows (25%) are deleted. The reason is not recorded.
- **Venue names drift, but not on dates.** 160 distinct venue spellings across active events. Where the same city and date have more than one venue spelling (11 groups), the difference is in words, not punctuation.
- **Undo is unused.** 387 shared-edition changes exist; none has been undone.

## Scale and history

- `logged_events`: 572 rows. 428 active, 144 soft-deleted.
- Creation is batched, not continuous. Almost all rows fall in four windows: 2026-10-20 to 10-22 (107 rows, the two-stage capture launch), 2026-11-02 (134, the calendar-venue batch), 2026-11-10 (319, the bulk import), and a trickle after that.
- Because of this, trends over time are weak. Any "rate" finding below describes one import batch as much as the person's ongoing behaviour.

## How events enter

| Signal | Count | Share of 572 |
|---|---|---|
| Field sources include a ticket-price key (likely email) | about 420 | about 74% |
| Linked to a shared edition (`edition_id`) | 45 | 8% |
| Linked to a canonical venue (`venue_id`) | 551 | 96% |
| Series set (`series_id`) | 38 | 7% |
| Any overrides recorded | 3 | 0.5% |
| Has a `seen` (acts marked) value | 139 | 24% |
| Format set by the person | 12 | 2% |
| Kind set (concert or festival) | 160 | 28% |

Observations:

- `captured` is populated on every row. The "what was first typed" record the rules require is intact.
- `overrides` is almost unused (3 rows). Either the person rarely overrides a linked edition, or the override path is hard to reach. Both are worth a question.
- Kind is left empty on 412 rows (72%). AGENTS.md says kind is worked out in code and only the person's own choice is stored, so this is expected. It means kind cannot yet be used for statistics.
- Format is almost never set (12 rows). It is the person's own words, so the low rate is probably fine. Worth confirming it is not hidden.

## Email import

From `email_imports` (1,830 scanned messages):

| Status | Count | Share |
|---|---|---|
| skipped | 958 | 52% |
| unreadable | 466 | 25% |
| new (not yet decided) | 199 | 11% |
| added | 208 | 11% |
| flag | 3 | 0.2% |

- A quarter of scanned messages are "unreadable". That is the biggest single loss in the funnel and has no recorded reason. A per-seller breakdown would show whether one seller accounts for most of it.
- 95 staged import records contain calendar-link text in their venue field. 60 of them reached `logged_events`; the other 35 were not checked for status in this audit.

## Corrections and edits

**Activity log** (`activity_log`, 4,171 rows): 465 creates, 3,574 updates, 144 deletes. There are no restore actions.

Fields updated most often:

| Field | Updates | Note |
|---|---|---|
| venue | 406 | Most-corrected personal field |
| country | 335 | |
| city | 334 | |
| region | 322 | |
| year | 298 | |
| seen | 190 | |
| startDate | 115 | |
| kind | 87 | |
| name | 76 | |

The `sources` (526) and `refs` (439) fields are probably written by the system, not the person. The log has no actor column, so this cannot be confirmed. Venue, city, country and region corrections together are about 1,400 updates. Most of that is location, which is the field the ticket email and lookup get wrong most often.

**Corrections table** (`corrections`, 1,495 rows): renamed 608, added 471, rejected 429 (29%). Source types involved: clashfinder 655, user 473, discovered 337, promoter 33.

**Source reliability** (`source_stats`, accepted vs rejected):

| Source | Accepted | Rejected | Reject rate |
|---|---|---|---|
| clashfinder (all) | 5,832 | 28 | 0.5% |
| discovered (all) | 349 | 163 | 32% |
| promoter (all) | 9 | 20 | 69% |

Clashfinder is involved in the most corrections because it supplies the most accepted items. Per item it is the most reliable source. The promoter source has too few items to judge.

**Shared editions** (`edition_changes`, 387 rows): member entry 135, canon backfill 123, owner 80, dedupe 35, learning 11, ingest 3. **None has been undone.** Editions: 136 verified, 69 provisional.

## Duplicates and identity

- Same person, same name, same date and same venue: 1 group (2 rows).
- Same person, same name, year-only: 0 groups.
- Venue spellings: 160 distinct across active events. Same date and city with different venue text: 11 groups. Same date with different text after stripping punctuation and case: 0. The drift is in words (for example "Los Angeles Historic Park" against "LA State Historic Park", the pair the fetch audit flagged).
- 35 venue values contain the city name as well, and 2 contain a comma. Both point to the free-text venue field taking more than it should.

## Opportunities

1. **Stop calendar text becoming a venue.** Strip calendar-link footers in the email parser per seller, and reject any venue that matches the pattern. Add a unit test. A one-off cleanup of the 60 affected rows needs Charlie's yes.
2. **Use the venue alias table for venue text.** `venue_aliases` and `canonical_venues` already exist (51 canonical venues). Map free-text venues to them on save. This addresses the drift with no new data.
3. **Give year-only events a path to a date.** 220 rows (38%) have no date. Offer a date prompt on save, or queue them for the stage 2 research path after the Stage 0 fix in PR #427.
4. **Find out why 25% of email messages are unreadable.** Record a reason code on each unreadable result, then group by seller.
5. **Record why events are deleted.** At 25%, this is either expected cleanup or a signal that imports create wrong rows. A reason field on delete answers it.
6. **Add an actor column to `activity_log`.** Right now system writes and person writes cannot be told apart. This is a migration, so Charlie applies it.
7. **Check whether undo is findable.** No shared-edition change has ever been undone, even though undo is a stated rule.

## Limits

- Batch creation means most patterns come from a few imports.
- `activity_log` has no actor, so human and system edits are not separated.
- `source_stats` counts are per source, not per field, so they cannot show which field was wrong.
- No data was read beyond aggregates. Names of people and any personal field were excluded by design.

## Needed from you

1. Do you want the 60 calendar-venue rows cleaned up? Reply yes or no. If yes, the cleanup will set the venue to empty and mark it as a system correction, so it can be undone.
2. Is the 25% deletion rate expected? Were most deletions duplicates, mistakes or test rows? A quick yes/no per type helps decide whether a delete reason is worth building.
3. Should unreadable email messages be retried later, or treated as final?

## Follow-up (2026-11-17, same day)

Charlie's answers and what was done.

**1. Calendar-link venues: cleaned up.** The venue was cleared on the 60 active rows that held the calendar-link text. Nothing else changed. The original text is still in each row's `captured.venue`, so restoring a row is `set venue = captured->>'venue'`. All 60 rows point to one `venue_id` (`27c60dc6-…`) that does not resolve in `venues` or `canonical_venues`. It is unexplained and needs its own look.

**2. Deletions: expected.** No change.

**3. Unreadable emails.** The 466 unreadable rows stored no reason, so the cause was unknown. By sender:
- Sickening.events: 68. No reader exists for it.
- Eventbrite: 49. Some are older layouts the readers still miss.
- Front Gate 12, Tixr 5, AXS 3. Ticket senders, probably recoverable with readers.
- About 120 from retail and general senders (Best Buy 35, USPS 22, Michaels 16, Newegg 16, others). These are not ticket mail, so the label is misleading.

Change: an unreadable row now stores the reader's own reason (`unreadableReason`, `src/server/events/email/imports.ts`). Rows imported before this change have no reason until they are read again.

**Scope and overlap.** The counts cover every row in `logged_events` (572, 7 users) and every row in `email_imports`. One member holds 315 of the 572 rows. No shared edition is linked by more than one user. Three pairs of users share an event name and date. Six same-city, same-date groups across users use different venue spellings.
