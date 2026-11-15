-- Global Archive Series, Brand, Aliases, Multi-Weekend Editions & Egress RPCs (Slice 1.2).
-- Additive and idempotent where possible; Charlie applies it in the Supabase SQL editor.
--
-- Privacy (AGENTS.md): shared tables and RPCs never expose personal fields.
-- Security: merge_canonical_series and stamp_unset_event_weekend are SECURITY DEFINER
-- with search_path = public, pg_temp and granted to service_role only.

-- 1. event_series: brand + aliases + search indexes.
alter table public.event_series add column if not exists brand text;
alter table public.event_series add column if not exists aliases text[] not null default '{}'::text[];

create index if not exists event_series_aliases_gin_idx on public.event_series using gin (aliases);
create index if not exists event_series_brand_lower_idx on public.event_series (lower(brand));

-- 2. event_editions: nullable series_slug (ON DELETE SET NULL), region, and weekends[].
alter table public.event_editions alter column series_slug drop not null;

alter table public.event_editions drop constraint if exists event_editions_series_slug_fkey;
alter table public.event_editions add constraint event_editions_series_slug_fkey
  foreign key (series_slug) references public.event_series(slug) on delete set null;

alter table public.event_editions add column if not exists region text;
alter table public.event_editions add column if not exists weekends jsonb not null default '[]'::jsonb;

alter table public.event_editions drop constraint if exists event_editions_weekends_array_check;
alter table public.event_editions add constraint event_editions_weekends_array_check
  check (jsonb_typeof(weekends) = 'array');

-- 3. Cleanup unused 1-off series stubs (standalone concerts that never carried series metadata).
update public.event_editions e
set series_slug = null
where series_slug in (
  select s.slug
  from public.event_series s
  left join public.event_editions ed on ed.series_slug = s.slug
  where s.lineup_url is null
    and s.clashfinder_slugs = '{}'::jsonb
  group by s.slug
  having count(ed.id) <= 1
);

delete from public.event_series s
where s.lineup_url is null
  and s.clashfinder_slugs = '{}'::jsonb
  and not exists (
    select 1 from public.event_editions ed where ed.series_slug = s.slug
  );

-- 4. RPC: edition_lineup_facts(p_ids text[])
-- Counts non-cancelled acts and checks Clashfinder provenance per edition in one query.
create or replace function public.edition_lineup_facts(p_ids text[])
returns table(edition_id text, act_count bigint, has_clashfinder boolean)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    p.edition_id,
    count(*)::bigint as act_count,
    coalesce(bool_or(exists (
      select 1
      from jsonb_array_elements(coalesce(p.sources, '[]'::jsonb)) elem
      where elem->>'sourceType' = 'clashfinder'
    )), false) as has_clashfinder
  from public.performances p
  where p.edition_id = any(p_ids)
    and p.status <> 'cancelled'
  group by p.edition_id;
$$;

-- 5. RPC: list_canonical_series_summary(p_query text, p_brand text, p_limit int)
create or replace function public.list_canonical_series_summary(
  p_query text default null,
  p_brand text default null,
  p_limit int default 100
)
returns table(
  slug text,
  name text,
  brand text,
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
    s.brand,
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

-- 6. RPC: merge_canonical_series(p_keep_slug text, p_drop_slug text)
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
  v_merged_aliases text[];
  v_merged_brand text;
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

  v_merged_brand := coalesce(nullif(btrim(v_keep.brand), ''), nullif(btrim(v_drop.brand), ''));
  v_merged_lineup_url := coalesce(nullif(btrim(v_keep.lineup_url), ''), nullif(btrim(v_drop.lineup_url), ''));
  v_merged_priority := case
    when v_keep.source_priority is not null and coalesce(array_length(v_keep.source_priority, 1), 0) > 0
      then v_keep.source_priority
    else v_drop.source_priority
  end;
  v_merged_cf := coalesce(v_drop.clashfinder_slugs, '{}'::jsonb) || coalesce(v_keep.clashfinder_slugs, '{}'::jsonb);

  update public.event_series
  set
    brand = v_merged_brand,
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

-- 7. RPC: stamp_unset_event_weekend(p_edition_id text, p_weekend int)
create or replace function public.stamp_unset_event_weekend(
  p_edition_id text,
  p_weekend int
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n_updated int;
begin
  if p_edition_id is null or btrim(p_edition_id) = '' then
    raise exception 'stamp_unset_event_weekend: edition_id is required';
  end if;
  if p_weekend is null or p_weekend < 1 or p_weekend > 9 then
    raise exception 'stamp_unset_event_weekend: weekend must be between 1 and 9';
  end if;

  update public.logged_events
  set weekend = p_weekend
  where edition_id = p_edition_id
    and deleted_at is null
    and weekend is null;
  get diagnostics n_updated = row_count;

  return n_updated;
end;
$$;

revoke all on function public.stamp_unset_event_weekend(text, int) from public, anon, authenticated;
grant execute on function public.stamp_unset_event_weekend(text, int) to service_role;
