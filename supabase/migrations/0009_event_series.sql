-- Series: the festival or tour an event is one edition of ("EDC Las Vegas"),
-- in your words, so its years show as "EDC Las Vegas 2024" and can be listed
-- together. Set only by you (LoggedEvent.series in src/server/events/types.ts).
-- DJ set, live set and B2B marks live in logged_events.seen and need no column.
-- Apply this before deploying the code that writes it.

alter table logged_events add column if not exists series text;
create index if not exists logged_events_series_idx on logged_events(series);
