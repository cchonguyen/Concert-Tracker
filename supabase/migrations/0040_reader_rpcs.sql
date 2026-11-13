-- Slice 11.4 (docs/ingest-canon-plan.md, C5). Written only; Charlie applies it in the Supabase SQL editor.
--
-- Two functions run every guard of the guarded reader and every ledger and log write, so one AI call
-- costs 3 Worker subrequests (reader_preflight, the provider call, reader_settle) instead of about 16
-- (one request per ledger read, ledger write and log insert). Nothing is dropped: the kill switch, the
-- breaker, the unpinned-model refusal, the input-size check, the per-job cap, both spend caps, the
-- provider and member daily caps, the owner reserve and the per-minute limit all still run, in the same
-- order, with the same reasons. The TypeScript in src/server/reader/guard.ts keeps the same logic for the
-- file store (used by tests and local runs) and calls these functions only for the Supabase store.
--
-- Additive and idempotent: create or replace only, no table changes. It reads and writes quota_ledger
-- (0002) and ai_calls (0038). No page text, prompt, quote, name or personal field is ever passed in or stored.
-- Security: security definer with a fixed search_path; execute is revoked from everyone and granted to
-- service_role only (the Worker's service key; same pattern as 0024). RLS from 0026 and 0039 is unchanged:
-- the definer runs as the table owner, so members and anon still cannot touch the ledger or the log.

-- reader_preflight(p_args jsonb) returns jsonb
--   Runs the guards and, when the call is allowed, reserves usage (provider day counter, member counter,
--   job counter). Opens the breaker where the TypeScript guard did (spend_day, spend_month, calls_cap).
--   Returns one of:
--     {"ok": true}
--     {"ok": false, "kind": "input_too_large"}
--     {"ok": false, "kind": "refuse", "reason": <text>, "retry_at": <timestamptz>, "scope": "global"|"user"|"job"}
--   p_args keys: now, enabled, provider_explicit, model, input_chars, max_input_chars, max_calls_per_job,
--   job_key, worst_micro, max_spend_day_micro, max_spend_month_micro, day_key, month_key, next_midnight,
--   next_month, cooldown_until, breaker_key, and optional quota {key, daily_limit, ignore_pause, user_key,
--   user_daily, owner_reserve, user_id, minute_blocked_until}.
create or replace function public.reader_preflight(p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := (p_args->>'now')::timestamptz;
  v_breaker_key text := p_args->>'breaker_key';
  v_cooldown timestamptz := (p_args->>'cooldown_until')::timestamptz;
  v_midnight timestamptz := (p_args->>'next_midnight')::timestamptz;
  v_month_start timestamptz := (p_args->>'next_month')::timestamptz;
  v_worst bigint := (p_args->>'worst_micro')::bigint;
  v_job_key text := 'reader:job:' || (p_args->>'job_key');
  v_exh timestamptz;
  v_used bigint;
  v_job_used int;
  v_q jsonb := p_args->'quota';
  v_q_key text;
  v_q_used int;
  v_q_exh timestamptz;
  v_u_key text;
  v_u_used int;
  v_u_daily int;
  v_reserve int;
  v_owner uuid;
  v_until timestamptz;
begin
  perform pg_advisory_xact_lock(7316004); -- serialises guards and settles so counters cannot be raced

  -- 1 kill switch
  if not coalesce((p_args->>'enabled')::boolean, false) then
    return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'kill_switch', 'retry_at', v_cooldown, 'scope', 'global');
  end if;

  -- 2 breaker open
  select exhausted_until into v_exh from quota_ledger where key = v_breaker_key;
  if v_exh is not null and v_exh > v_now then
    return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'breaker_open', 'retry_at', v_exh, 'scope', 'global');
  end if;

  -- 3 unpinned model (only when the provider was chosen explicitly)
  if coalesce((p_args->>'provider_explicit')::boolean, false) and (p_args->>'model') ~* '-latest\y' then
    return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'unpinned_model', 'retry_at', v_cooldown, 'scope', 'global');
  end if;

  -- 5 input size: a result, never a breaker change
  if (p_args->>'input_chars')::bigint > (p_args->>'max_input_chars')::bigint then
    return jsonb_build_object('ok', false, 'kind', 'input_too_large');
  end if;

  -- 6 calls per job: parks only this job
  select used into v_job_used from quota_ledger where key = v_job_key;
  v_job_used := coalesce(v_job_used, 0);
  if v_job_used >= (p_args->>'max_calls_per_job')::int then
    return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'job_cap', 'retry_at', v_midnight, 'scope', 'job');
  end if;

  -- 7 daily spend cap
  select used into v_used from quota_ledger where key = p_args->>'day_key';
  if coalesce(v_used, 0) + v_worst > (p_args->>'max_spend_day_micro')::bigint then
    insert into quota_ledger (key, used, exhausted_until) values (v_breaker_key, 0, v_midnight)
      on conflict (key) do update set exhausted_until = excluded.exhausted_until;
    return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'spend_day', 'retry_at', v_midnight, 'scope', 'global');
  end if;

  -- 8 monthly spend cap
  select used into v_used from quota_ledger where key = p_args->>'month_key';
  if coalesce(v_used, 0) + v_worst > (p_args->>'max_spend_month_micro')::bigint then
    insert into quota_ledger (key, used, exhausted_until) values (v_breaker_key, 0, v_month_start)
      on conflict (key) do update set exhausted_until = excluded.exhausted_until;
    return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'spend_month', 'retry_at', v_month_start, 'scope', 'global');
  end if;

  -- 9 provider calls per day, member caps and per-minute limit (last, so counters advance only for calls that will be made)
  if v_q is not null and jsonb_typeof(v_q) = 'object' then
    v_q_key := v_q->>'key';
    select used, exhausted_until into v_q_used, v_q_exh from quota_ledger where key = v_q_key;
    v_q_used := coalesce(v_q_used, 0);

    v_u_key := v_q->>'user_key';
    if v_u_key is not null then
      select used into v_u_used from quota_ledger where key = v_u_key;
      v_u_used := coalesce(v_u_used, 0);
      v_u_daily := coalesce((v_q->>'user_daily')::int, 0);
      v_reserve := coalesce((v_q->>'owner_reserve')::int, 0);
      if v_u_daily > 0 and v_u_used >= v_u_daily then
        return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'user_daily', 'retry_at', v_midnight, 'scope', 'user');
      end if;
      if v_reserve > 0 then
        select user_id into v_owner from members where role = 'owner';
        if (v_q->>'user_id')::uuid is distinct from v_owner
           and v_q_used >= (v_q->>'daily_limit')::int - v_reserve then
          return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'owner_reserve', 'retry_at', v_midnight, 'scope', 'user');
        end if;
      end if;
    end if;

    -- a global refusal here opens the breaker with the same reason the TypeScript guard used: calls_cap
    if not coalesce((v_q->>'ignore_pause')::boolean, false) and v_q_exh is not null and v_q_exh > v_now then
      v_until := v_q_exh;
    elsif v_q_used >= (v_q->>'daily_limit')::int then
      v_until := v_midnight;
      insert into quota_ledger (key, used, exhausted_until) values (v_q_key, v_q_used, v_until)
        on conflict (key) do update set exhausted_until = excluded.exhausted_until;
    elsif nullif(v_q->>'minute_blocked_until', '') is not null then
      v_until := (v_q->>'minute_blocked_until')::timestamptz;
    end if;
    if v_until is not null then
      insert into quota_ledger (key, used, exhausted_until) values (v_breaker_key, 0, v_until)
        on conflict (key) do update set exhausted_until = excluded.exhausted_until;
      return jsonb_build_object('ok', false, 'kind', 'refuse', 'reason', 'calls_cap', 'retry_at', v_until, 'scope', 'global');
    end if;

    insert into quota_ledger (key, used, exhausted_until) values (v_q_key, v_q_used + 1, null)
      on conflict (key) do update set used = excluded.used, exhausted_until = null;
    if v_u_key is not null then
      insert into quota_ledger (key, used) values (v_u_key, v_u_used + 1)
        on conflict (key) do update set used = excluded.used;
    end if;
  end if;

  -- the job counter advances only for a call that will be made
  insert into quota_ledger (key, used) values (v_job_key, v_job_used + 1)
    on conflict (key) do update set used = excluded.used;
  return jsonb_build_object('ok', true);
end;
$$;

-- reader_settle(p_args jsonb) returns void
--   After the provider call (or after a refusal): updates the ledger (calls this month, day and month
--   spend, breaker) and inserts the single ai_calls row, in one call. With "record_ledger": false only the
--   row is written (a refused call made no provider call).
--   p_args keys: record_ledger, now, outcome (success|quota|busy|error|invalid_json), cost_micro,
--   calls_month_key, day_key, month_key, breaker_key, breaker_failures, breaker_until, and row {id,
--   created_at, feature, job_id, event_id, user_id, provider, model, source_document_id, input_chars,
--   input_tokens, output_tokens, est_cost_usd, duration_ms, outcome, error_code, guard_reason,
--   names_returned, names_verbatim, names_rejected}. The row holds counts and sizes only. Without a row
--   the ledger part alone runs.
create or replace function public.reader_settle(p_args jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost bigint := coalesce((p_args->>'cost_micro')::bigint, 0);
  v_outcome text := p_args->>'outcome';
  v_breaker_key text := p_args->>'breaker_key';
  v_until timestamptz := (p_args->>'breaker_until')::timestamptz;
  v_used int;
  r jsonb := p_args->'row';
begin
  perform pg_advisory_xact_lock(7316004);

  if coalesce((p_args->>'record_ledger')::boolean, false) then
    -- owner view: every provider call this UTC month, whatever its outcome
    insert into quota_ledger (key, used) values (p_args->>'calls_month_key', 1)
      on conflict (key) do update set used = quota_ledger.used + 1;
    if v_cost > 0 then
      insert into quota_ledger (key, used) values (p_args->>'day_key', v_cost)
        on conflict (key) do update set used = quota_ledger.used + v_cost;
      insert into quota_ledger (key, used) values (p_args->>'month_key', v_cost)
        on conflict (key) do update set used = quota_ledger.used + v_cost;
    end if;

    -- breaker: success resets the failure count; quota opens it until the provider's retry time;
    -- any other failure counts toward the trip threshold
    if v_outcome = 'success' then
      update quota_ledger set used = 0 where key = v_breaker_key and used <> 0;
    elsif v_outcome = 'quota' then
      insert into quota_ledger (key, used, exhausted_until) values (v_breaker_key, 0, v_until)
        on conflict (key) do update set exhausted_until = excluded.exhausted_until;
    else
      select used into v_used from quota_ledger where key = v_breaker_key;
      v_used := coalesce(v_used, 0) + 1;
      if v_used >= (p_args->>'breaker_failures')::int then
        insert into quota_ledger (key, used, exhausted_until) values (v_breaker_key, v_used, v_until)
          on conflict (key) do update set used = excluded.used, exhausted_until = excluded.exhausted_until;
      else
        insert into quota_ledger (key, used) values (v_breaker_key, v_used)
          on conflict (key) do update set used = excluded.used;
      end if;
    end if;
  end if;

  if r is not null and r ? 'id' then
  insert into ai_calls (
    id, created_at, feature, job_id, event_id, user_id, provider, model, source_document_id,
    input_chars, input_tokens, output_tokens, est_cost_usd, duration_ms, outcome, error_code,
    guard_reason, names_returned, names_verbatim, names_rejected
  ) values (
    (r->>'id')::uuid, (r->>'created_at')::timestamptz, r->>'feature',
    (r->>'job_id')::uuid, (r->>'event_id')::uuid, (r->>'user_id')::uuid,
    r->>'provider', r->>'model', (r->>'source_document_id')::uuid,
    (r->>'input_chars')::int, (r->>'input_tokens')::int, (r->>'output_tokens')::int,
    (r->>'est_cost_usd')::numeric, (r->>'duration_ms')::int, r->>'outcome', r->>'error_code',
    r->>'guard_reason', (r->>'names_returned')::int, (r->>'names_verbatim')::int, (r->>'names_rejected')::int
  ) on conflict (id) do nothing;
  end if;
end;
$$;

revoke all on function public.reader_preflight(jsonb) from public, anon, authenticated;
revoke all on function public.reader_settle(jsonb) from public, anon, authenticated;
grant execute on function public.reader_preflight(jsonb) to service_role;
grant execute on function public.reader_settle(jsonb) to service_role;

-- Check (run after applying; expect both functions, prosecdef true, execute for service_role only):
--   select p.proname, p.prosecdef, p.proconfig, p.proacl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in ('reader_preflight','reader_settle');

-- Rollback (the app then needs the pre-0040 code, which does not call them):
--   drop function if exists public.reader_preflight(jsonb);
--   drop function if exists public.reader_settle(jsonb);
