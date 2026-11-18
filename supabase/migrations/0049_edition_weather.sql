-- Shared weather on a canonical edition: one record for every member who saves
-- an event from it (EventWeather in src/server/events/types.ts). Written once per
-- edition, refreshed only on an admin request. See docs/specs/canonical-weather.md.
-- Held: Charlie applies this migration; do not merge the PR that depends on it until he says applied.

alter table event_editions add column if not exists weather jsonb;
