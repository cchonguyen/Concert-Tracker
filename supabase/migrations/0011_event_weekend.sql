-- Weekend: which weekend of a festival that runs more than one an event was
-- (Weekend 1, 2, ...), as you pick it (LoggedEvent.weekend in
-- src/server/events/types.ts). Shown with the series. Numbered 0011 because
-- 0010 is taken by the city/region split.
-- Apply this before deploying the code that writes it.

alter table logged_events add column if not exists weekend int check (weekend between 1 and 9);
