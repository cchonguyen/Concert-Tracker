-- Links series that already carry brand text but no brand_id (found 2026-11-18: Brownies & Lemonade,
-- Day Trip, Outloud Music Festival). Series saved before the save path linked brands never got a row.
-- Additive and idempotent: inserts missing brands by name key, then sets brand_id only where it is null.
-- Charlie applies it in the Supabase SQL editor. Threads never apply migrations.

-- 1. One brand row per distinct trimmed, case-insensitive brand text still unlinked.
insert into public.brands (id, name, name_key)
select distinct on (lower(btrim(s.brand)))
  gen_random_uuid(),
  btrim(s.brand),
  lower(btrim(s.brand))
from public.event_series s
where s.brand_id is null
  and s.brand is not null
  and length(btrim(s.brand)) > 0
order by lower(btrim(s.brand)), s.brand
on conflict (name_key) do nothing;

-- 2. Link every unlinked series to the brand row with its key.
update public.event_series s
set brand_id = b.id
from public.brands b
where s.brand_id is null
  and s.brand is not null
  and b.name_key = lower(btrim(s.brand));
