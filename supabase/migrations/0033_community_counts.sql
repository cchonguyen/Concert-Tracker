-- Community counts for the Global Archive (see ARCHITECTURE.md, "Global Archive").
-- Not applied to the live database until Charlie's go.
--
-- For each artist name, how many distinct members have it on a live (not deleted)
-- event. The function returns only a name key and a number: no member ids, no
-- names, no event data. Encrypted names (vault ciphertext, "v1:...") are skipped.
-- It reads other members' rows, so it is security definer and callable only by
-- the server (service role). The owner check happens in the route.
--
-- Key matching is approximate: the server matches these keys to canonical keys
-- with normalizeName. Diacritics are not stripped here, so an artist written with
-- accents may count lower than it should.

create or replace function canonical_community_counts()
returns table(name_key text, member_count int)
language sql stable security definer set search_path = public
as $$
  select pairs.name_key, count(distinct pairs.user_id)::int
  from (
    select e.user_id,
           lower(btrim(regexp_replace(replace(s->>'name', '&', ' and '), '[^[:alnum:]]+', ' ', 'g'))) as name_key
    from (
      select user_id, seen
      from logged_events
      where deleted_at is null and jsonb_typeof(seen) = 'array'
    ) e
    cross join lateral jsonb_array_elements(e.seen) s
    where s->>'name' is not null
      and btrim(s->>'name') <> ''
      and s->>'name' not like 'v1:%'
  ) pairs
  where pairs.name_key <> ''
  group by pairs.name_key;
$$;

revoke all on function canonical_community_counts() from public, anon, authenticated;
grant execute on function canonical_community_counts() to service_role;
