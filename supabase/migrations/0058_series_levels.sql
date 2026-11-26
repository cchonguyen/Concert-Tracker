-- Series cleanup, slice 3: brand, series and edition each store only their own words.
-- Additive and nullable: no existing row changes, and code that does not know these columns keeps working.
-- Charlie applies this in the Supabase SQL editor. Held until he says it is applied.

-- 1. What sets a series apart inside its brand: a place for a festival ("SoCal"), the tour name for a tour ("Duality Tour").
--    Empty when the brand alone names it. The shown name is built in code from the brand and this.
alter table public.event_series add column if not exists qualifier text;

-- 2. A short name for one edition when that night has its own ("1000", "No Phone Zone"). Never a year or a weekend.
alter table public.event_editions add column if not exists subtitle text;

-- 3. A member's event points at its shared series. `series` stays as the member's own wording and is never cleared here.
alter table public.logged_events add column if not exists series_slug text
  references public.event_series(slug) on delete set null;
create index if not exists logged_events_series_slug_idx on public.logged_events (series_slug) where series_slug is not null;
