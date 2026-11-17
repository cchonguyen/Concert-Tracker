-- Brands as a table (Global Editions slice 1). Additive and idempotent where possible;
-- Charlie applies it in the Supabase SQL editor before the code that reads brand_id deploys.
--
-- Hierarchy: Organization -> Brand -> Series -> Edition -> Weekend/Event. Organization is the
-- existing entities row (kind 'organization'); a brand may have none. One brand per series.
--
-- Privacy (AGENTS.md): shared tables never hold personal fields. Brands are public facts only.
-- event_series.brand (text) stays in place during the transition; the backfill copies it
-- into brands once. A later slice switches reads to brand_id and drops the text column.

-- 1. brands: one row per brand. name_key is the case-insensitive, trimmed name, unique.
create table if not exists public.brands (
  id uuid primary key,
  name text not null,
  name_key text not null,
  aliases text[] not null default '{}'::text[],
  organization_id uuid references public.entities(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brands_name_nonblank check (length(btrim(name)) > 0),
  constraint brands_name_key_unique unique (name_key)
);

create index if not exists brands_organization_idx on public.brands (organization_id);

alter table public.brands enable row level security;

-- 2. event_series.brand_id: nullable, one brand per series. Deleting a brand unlinks its series.
alter table public.event_series add column if not exists brand_id uuid
  references public.brands(id) on delete set null;

create index if not exists event_series_brand_id_idx on public.event_series (brand_id);

-- 3. Backfill: one brand per distinct trimmed, case-insensitive name already on a series.
--    Deterministic ids (md5-based uuid) so re-running the migration does not create new rows.
insert into public.brands (id, name, name_key)
select distinct on (lower(btrim(s.brand)))
  (substr(md5('brand:' || lower(btrim(s.brand))), 1, 8) || '-' ||
   substr(md5('brand:' || lower(btrim(s.brand))), 9, 4) || '-' ||
   substr(md5('brand:' || lower(btrim(s.brand))), 13, 4) || '-' ||
   substr(md5('brand:' || lower(btrim(s.brand))), 17, 4) || '-' ||
   substr(md5('brand:' || lower(btrim(s.brand))), 21, 12))::uuid,
  btrim(s.brand),
  lower(btrim(s.brand))
from public.event_series s
where s.brand is not null and length(btrim(s.brand)) > 0
order by lower(btrim(s.brand)), s.brand
on conflict (name_key) do nothing;

update public.event_series s
set brand_id = b.id
from public.brands b
where s.brand_id is null
  and s.brand is not null
  and b.name_key = lower(btrim(s.brand));
