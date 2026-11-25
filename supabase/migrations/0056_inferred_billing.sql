-- Inferred billing roles for shared editions (docs/specs/inferred-values.md, section Storage).
-- Written, not applied: Charlie applies it, then the code that uses it can ship.
--
-- A billing row names an act by its artist key in `subject`. Field 'billing' needs a subject, and no other
-- field takes one. At most one 'active' row per edition, field and subject.
--
-- Additive and idempotent: add column if not exists, drop-then-create for constraints and indexes. Safe to run twice.

-- 1. The act a billing row is about (its artist key). Null for every edition field.
alter table public.edition_inferences add column if not exists subject text;

-- 2. field may also be 'billing'.
alter table public.edition_inferences drop constraint if exists edition_inferences_field_check;
alter table public.edition_inferences add constraint edition_inferences_field_check
  check (field in ('startDate', 'endDate', 'venue', 'city', 'region', 'country', 'billing'));

-- 3. A subject is present exactly when the field is 'billing'.
alter table public.edition_inferences drop constraint if exists edition_inferences_subject_check;
alter table public.edition_inferences add constraint edition_inferences_subject_check
  check ((field = 'billing') = (subject is not null));

-- 4. One active inference per edition, field and subject (replaces the per edition and field index from 0055).
drop index if exists public.edition_inferences_active_uidx;
create unique index if not exists edition_inferences_active_uidx
  on public.edition_inferences (edition_id, field, coalesce(subject, '')) where status = 'active';
