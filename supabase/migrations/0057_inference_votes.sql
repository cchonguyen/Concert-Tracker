-- Member Verify taps on inferred values (docs/specs/inferred-values.md, step 7).
-- Written, not applied: Charlie applies it, then the code that uses it can ship.
--
-- One row per inference and member. Two different members verifying the same active inferred value
-- write it into the shared edition (src/server/canon/inferenceReview.ts). Only the server writes this table.
-- Owner reads only (the Worker serves members). No personal fields are stored here.
--
-- Additive and idempotent: create ... if not exists, drop-then-create for policies. Safe to run twice.

-- 1. inference_votes: who verified which inferred value, and when.
create table if not exists public.inference_votes (
  id uuid primary key default gen_random_uuid(),
  inference_id uuid not null references public.edition_inferences(id) on delete cascade,
  member_id text not null,
  created_at timestamptz not null default now(),
  unique (inference_id, member_id)
);

-- 2. Row level security: owner reads only. No write policy is set, so a member's session cannot write.
alter table public.inference_votes enable row level security;

drop policy if exists "owner_read" on public.inference_votes;
create policy "owner_read" on public.inference_votes for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));
