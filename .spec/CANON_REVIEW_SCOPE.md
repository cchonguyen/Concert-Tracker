# Scope: anonymous review and elevate of member-entered events (triage, 2026-11-14)

Status: PROPOSED. Not approved. Nothing built. Source: Charlie, 2026-11-13.

## Goal
The owner sees what members entered in their personal events, without seeing who and without private fields. The owner checks the facts, elevates good ones to verified editions, and every member then sees and is autofilled from them.

## What exists (main at 816cc86)
- Owner inbox: Manage > Global archive (AdminInbox.tsx). Lists review_queue rows; actions: use override for everyone, mark verified, merge, dismiss, undo (reviewRoutes.ts).
- Edition list and fact editing: Global archive > Editions & Lineups (edit name, dates, venue, city with a source note).
- Inheritance on read (inherit.ts): override, then edition, then captured.
- Member edits of a linked event create an `override` review row (payload field, old, new; no identity).

## Gaps found
1. Autofill reads only status `confirmed` (supabaseStore.ts:546, store/types.ts:131). `verified` and `provisional` editions never autofill for members.
2. Nothing creates `provisional` review rows or `failed_lookup` rows. "Mark verified" can never appear.
3. Members' entries never create provisional editions (researchCatalogFor persists only for owner or single-user). Needs the member notice approval first.
4. Editions list status filter compares `confirmed`/`draft` only; verified and provisional rows show as "draft".
5. No create-by-hand and no generic "promote to verified" action for an edition.
6. No anonymous list of member events (logged_events is per user; no owner endpoint).
7. No agreement counting (N members make the same edit).
8. No "not verified" label in the picker.
9. GET /api/editions has no owner guard and returns 100 editions of any status to any member.
10. Notice and invite email say nobody, including the owner, can see an archive. NOTICE_VERSION = 1.

## Proposed slices (each under 5 files; order matters)
- A [CORE] Treat `verified` like `confirmed` everywhere (autofill, filter, labels, GET /api/editions guard). No migration.
- B [CORE] Anonymous candidate list: a read-only owner RPC returning, per unlinked member event, only name, dates, venue, city, region, country, and a count of members with the same normalized entry. No user id, no row id that maps to a user, no companions, notes, rating, price or attendance. A test fails if any other field appears. Needs a migration (Charlie applies).
- C [UI] Owner "Member entries" tab in Global archive: groups by normalized name and date, shows member count, search by city and status.
- D [CORE+UI] Elevate: one tap creates a `verified` edition through writeEdition (undoable, recorded), then links matching member events by the stored edition id. Edit-before-elevate uses the existing facts form. Includes manual create-verified.
- E [CORE] Provisional editions from member entries plus a `provisional` review row; needs the notice bump (Charlie approves text) and a re-accept before shipping. Optional, after D.
- F [UI] "Not verified" label for provisional editions in the picker.

Deferred: agreement threshold (auto-elevate at N members), member flags, personal-field privacy.

## Privacy rules for the reviewer view
- Never return or log member identity, user id, email, or a key that maps back to a user.
- Never return companions, notes, rating, price, attendance, or day counts.
- Small groups (1 member) are identifiable by context; show the count only and let Charlie decide whether to hide groups of 1.
- Reviewing member-entered data changes what the notice says; the notice text and invite email must be updated and NOTICE_VERSION bumped before B ships.

## Do NOT Build
- Any view of who entered an event, or any per-member breakdown.
- Personal fields in any shared table, RPC result, trace, log or the review queue.
- Auto-elevate or auto-verify without the owner's tap.
- Model calls to check or "improve" member entries.
- Hardcoded festival, venue or artist lists.
- Encryption of personal fields (held).
- Changes to capture, sync, or autosave (separate thread).
- Setlist or lineup copies beyond what source terms allow.
