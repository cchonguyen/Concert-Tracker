-- Series Kind (festival | tour) and Place (city, region, country) (Slice 2.2).
-- Additive and idempotent where possible; Charlie applies it in the Supabase SQL editor.
--
-- Privacy (AGENTS.md): shared tables and RPCs never expose personal fields.
-- Security: merge_canonical_series stays SECURITY DEFINER with search_path = public, pg_temp
-- and granted to service_role only; list_canonical_series_summary stays SECURITY INVOKER.

-- 1. event_series: kind ('festival' | 'tour') + fixed place columns (city, region, country).
alter table public.event_series add column if not exists kind text not null default 'festival';
alter table public.event_series drop constraint if exists event_series_kind_check;
alter table public.event_series add constraint event_series_kind_check
  check (kind in ('festival', 'tour'));

alter table public.event_series add column if not exists city text;
alter table public.event_series add column if not exists region text;
alter table public.event_series add column if not exists country text;

-- 2. RPC: list_canonical_series_summary(p_query text, p_brand text, p_limit int)
-- Signature changes (returns table adds kind, city, region, country), so drop and recreate.
drop function if exists public.list_canonical_series_summary(text, text, int);

create or replace function public.list_canonical_series_summary(
  p_query text default null,
  p_brand text default null,
  p_limit int default 100
)
returns table(
  slug text,
  name text,
  kind text,
  brand text,
  city text,
  region text,
  country text,
  aliases text[],
  lineup_url text,
  clashfinder_slugs jsonb,
  source_priority text[],
  edition_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    s.slug,
    s.name,
    s.kind,
    s.brand,
    s.city,
    s.region,
    s.country,
    s.aliases,
    s.lineup_url,
    s.clashfinder_slugs,
    s.source_priority,
    count(ed.id)::bigint as edition_count
  from public.event_series s
  left join public.event_editions ed on ed.series_slug = s.slug
  where (
    nullif(btrim(p_query), '') is null
    or s.slug ilike '%' || btrim(p_query) || '%'
    or s.name ilike '%' || btrim(p_query) || '%'
    or coalesce(s.brand, '') ilike '%' || btrim(p_query) || '%'
    or exists (
      select 1 from unnest(s.aliases) a where a ilike '%' || btrim(p_query) || '%'
    )
  )
  and (
    nullif(btrim(p_brand), '') is null
    or lower(coalesce(s.brand, '')) = lower(btrim(p_brand))
  )
  group by s.slug
  order by coalesce(s.brand, s.name) asc, s.name asc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- 3. RPC: merge_canonical_series(p_keep_slug text, p_drop_slug text)
create or replace function public.merge_canonical_series(
  p_keep_slug text,
  p_drop_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keep public.event_series%rowtype;
  v_drop public.event_series%rowtype;
  v_merged_kind text;
  v_merged_aliases text[];
  v_merged_brand text;
  v_merged_city text;
  v_merged_region text;
  v_merged_country text;
  v_merged_lineup_url text;
  v_merged_priority text[];
  v_merged_cf jsonb;
  n_editions int;
begin
  if p_keep_slug is null or p_drop_slug is null or btrim(p_keep_slug) = '' or btrim(p_drop_slug) = '' then
    raise exception 'merge_canonical_series: both slugs are required';
  end if;
  if p_keep_slug = p_drop_slug then
    raise exception 'merge_canonical_series: keep and drop slugs are the same';
  end if;

  -- Lock both rows in deterministic order to avoid deadlocks.
  perform 1 from public.event_series where slug in (p_keep_slug, p_drop_slug) order by slug for update;

  select * into v_keep from public.event_series where slug = p_keep_slug;
  if not found then
    raise exception 'merge_canonical_series: series % not found', p_keep_slug;
  end if;

  select * into v_drop from public.event_series where slug = p_drop_slug;
  if not found then
    raise exception 'merge_canonical_series: series % not found', p_drop_slug;
  end if;

  select coalesce(array_agg(x order by ord), '{}'::text[])
  into v_merged_aliases
  from (
    select distinct on (lower(btrim(val))) btrim(val) as x, ord
    from unnest(
      coalesce(v_keep.aliases, '{}'::text[])
      || coalesce(v_drop.aliases, '{}'::text[])
      || case
           when lower(btrim(v_drop.name)) <> lower(btrim(v_keep.name)) then array[v_drop.name]
           else '{}'::text[]
         end
    ) with ordinality as t(val, ord)
    where btrim(val) <> ''
    order by lower(btrim(val)), ord
  ) sub;

  v_merged_kind := coalesce(v_keep.kind, v_drop.kind, 'festival');
  v_merged_brand := coalesce(nullif(btrim(v_keep.brand), ''), nullif(btrim(v_drop.brand), ''));
  if v_merged_kind = 'tour' then
    v_merged_city := null;
    v_merged_region := null;
    v_merged_country := null;
  else
    v_merged_city := coalesce(nullif(btrim(v_keep.city), ''), nullif(btrim(v_drop.city), ''));
    v_merged_region := coalesce(nullif(btrim(v_keep.region), ''), nullif(btrim(v_drop.region), ''));
    v_merged_country := coalesce(nullif(btrim(v_keep.country), ''), nullif(btrim(v_drop.country), ''));
  end if;
  v_merged_lineup_url := coalesce(nullif(btrim(v_keep.lineup_url), ''), nullif(btrim(v_drop.lineup_url), ''));
  v_merged_priority := case
    when v_keep.source_priority is not null and coalesce(array_length(v_keep.source_priority, 1), 0) > 0
      then v_keep.source_priority
    else v_drop.source_priority
  end;
  v_merged_cf := coalesce(v_drop.clashfinder_slugs, '{}'::jsonb) || coalesce(v_keep.clashfinder_slugs, '{}'::jsonb);

  update public.event_series
  set
    kind = v_merged_kind,
    brand = v_merged_brand,
    city = v_merged_city,
    region = v_merged_region,
    country = v_merged_country,
    aliases = v_merged_aliases,
    lineup_url = v_merged_lineup_url,
    source_priority = v_merged_priority,
    clashfinder_slugs = v_merged_cf
  where slug = p_keep_slug;

  update public.event_editions
  set series_slug = p_keep_slug
  where series_slug = p_drop_slug;
  get diagnostics n_editions = row_count;

  delete from public.event_series where slug = p_drop_slug;

  return jsonb_build_object(
    'keep_slug', p_keep_slug,
    'drop_slug', p_drop_slug,
    'editions_moved', n_editions,
    'aliases_count', coalesce(array_length(v_merged_aliases, 1), 0)
  );
end;
$$;

revoke all on function public.merge_canonical_series(text, text) from public, anon, authenticated;
grant execute on function public.merge_canonical_series(text, text) to service_role;
