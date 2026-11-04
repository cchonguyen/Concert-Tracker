-- Applied to the live database by Charlie (RLS, 2026-10-29). Committed here as the record.
-- Closes the advisor finding on owner_user_id(). Live check (read-only): anon and authenticated
-- can both run it. The earlier draft's "revoke from anon" did not take effect, most likely
-- because functions also carry a default grant to PUBLIC, which the anon role inherits.
--
-- Before running: check that the activity_log policies (which call owner_user_id) still
-- work for authenticated members after the change. They run as the member, so keep
-- authenticated's EXECUTE. Only the PUBLIC and anon grants go.

revoke execute on function public.owner_user_id() from public;
revoke execute on function public.owner_user_id() from anon;

-- Verify afterwards (should both be false for anon; authenticated stays true):
--   select has_function_privilege('anon','public.owner_user_id()','EXECUTE'),
--          has_function_privilege('authenticated','public.owner_user_id()','EXECUTE');

-- Rollback:
--   grant execute on function public.owner_user_id() to public;
