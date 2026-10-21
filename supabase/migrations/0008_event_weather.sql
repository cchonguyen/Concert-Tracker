-- Weather on the days of an event, from the Open-Meteo archive, stored with
-- the place it matched and the URL it was read from (EventWeather in
-- src/server/events/types.ts). Filled only when you ask.
-- Apply this before deploying the code that writes it.

alter table logged_events add column if not exists weather jsonb;
