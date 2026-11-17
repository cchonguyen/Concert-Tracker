-- Brand change history (Global Editions slice 2). Additive and idempotent; Charlie applies it
-- in the Supabase SQL editor before the store that writes brand_history deploys.
--
-- Each brand rename, merge or organization change writes one row with the manifest needed to
-- undo it (the same pattern as entity_history). Shared data only: no personal fields.

create table if not exists public.brand_history (
  id uuid primary key,
  operation text not null check (operation in ('rename', 'merge', 'organization')),
  brand_id uuid not null,
  merged_from_id uuid,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

create index if not exists brand_history_brand_idx on public.brand_history (brand_id);

alter table public.brand_history enable row level security;
