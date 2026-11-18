-- Member proposals for a shared lineup (docs/edition-lineup-from-name-spec.md, slice 4).
-- Adds the review queue kind lineup_proposal. Payloads hold the artist key, its name and the edition name only.
-- Written, not applied: Charlie applies it, then the proposal route can write rows.
alter table public.review_queue drop constraint if exists review_queue_kind_check;
alter table public.review_queue add constraint review_queue_kind_check
  check (kind in ('override', 'merge_suggestion', 'provisional', 'formatting', 'failed_lookup', 'lineup_proposal'));
