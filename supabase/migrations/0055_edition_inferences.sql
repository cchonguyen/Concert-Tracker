-- Inferred values for shared editions (docs/specs/inferred-values.md, section Storage).
-- Written, not applied: Charlie applies it, then the code that uses it can ship.
--
-- One row per inferred value on an edition field. At most one 'active' row per edition and field.
-- Rows are kept when they are replaced, confirmed or rejected, so the lineage stays readable.
-- Owner reads only (the Worker serves members). No personal fields are stored here.
--
-- Additive and idempotent: create ... if not exists, drop-then-create for policies. Safe to run twice.

-- 1. edition_inferences: the inferred value, why it was made, what it was built from, and how it ended.
create table if not exists public.edition_inferences (
  id uuid primary key default gen_random_uuid(),
  edition_id text not null references public.event_editions(id) on delete cascade,
  field text not null check (field in ('startDate', 'endDate', 'venue', 'city', 'region', 'country')),
  value jsonb not null,
  reason text not null check (length(btrim(reason)) > 0),
  rule text not null,              -- the code rule's name, or 'reader'
  inputs jsonb not null default '[]'::jsonb,  -- {kind:'source', url, quote} | {kind:'record', table, id} | {kind:'inference', id}
  parents uuid[] not null default '{}',       -- the inferences this one was built from (the lineage)
  status text not null default 'active' check (status in ('active', 'confirmed', 'replaced', 'rejected')),
  actor text not null,             -- a member id, 'owner', or the name of a job or rule
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolved_reason text
);

-- One active inference per edition and field.
create unique index if not exists edition_inferences_active_uidx
  on public.edition_inferences (edition_id, field) where status = 'active';
create index if not exists edition_inferences_edition_idx on public.edition_inferences (edition_id);
-- Finds the rows built on a given inference (healing walks the lineage).
create index if not exists edition_inferences_parents_idx on public.edition_inferences using gin (parents);

-- 2. Row level security: owner reads only. No write policy is set, so a member's session cannot write.
alter table public.edition_inferences enable row level security;

drop policy if exists "owner_read" on public.edition_inferences;
create policy "owner_read" on public.edition_inferences for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));
