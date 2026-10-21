-- Format: what kind of night an event was (club night, warehouse party,
-- block party, ...), in your words. Separate from Concert or Festival
-- (logged_events.kind), optional, and never filled by the app.
-- Apply this before deploying the code that writes it.

alter table logged_events add column if not exists format text;
