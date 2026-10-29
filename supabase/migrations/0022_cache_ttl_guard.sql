-- The response cache may hold a row for at most 24 hours, whatever the app
-- writes (src/server/lineup/responseCache.ts). Safe to apply any time.
delete from source_response_cache where expires_at > fetched_at + interval '24 hours';
alter table source_response_cache drop constraint if exists source_response_cache_ttl;
alter table source_response_cache add constraint source_response_cache_ttl check (expires_at <= fetched_at + interval '24 hours');
