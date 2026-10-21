-- Artist and Supporting artists, Concert or Festival. See ARCHITECTURE.md
-- ("Billing roles" and "Concert or festival").
-- A billing role is stored only when a source's quoted words bill the act as
-- headliner or support, or you set it; no role means no lead was stated, and
-- the act is listed under Artist. Seen acts carry their role inside
-- logged_events.seen (JSON), so they need no column.
-- Apply this before deploying the code that reads it.

alter table performer_claims add column if not exists billing text
  check (billing in ('headliner', 'support'));

alter table performances add column if not exists billing text
  check (billing in ('headliner', 'support'));

-- Your choice only; without it the app works the type out from the event.
alter table logged_events add column if not exists kind text
  check (kind in ('concert', 'festival'));
