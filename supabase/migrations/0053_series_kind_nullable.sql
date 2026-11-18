-- Series type fix, slice 2: a series may have no type yet (kind NULL = "Not set").
-- Existing rows are not changed: a row typed 'festival' or 'tour' stays as it is.
-- Charlie applies this in the Supabase SQL editor. Held until he says it is applied.

-- 1. Drop the default that made every new or existing series a festival.
alter table public.event_series alter column kind drop default;

-- 2. Allow an empty type. The check constraint from 0046 still allows only festival or tour.
alter table public.event_series alter column kind drop not null;
