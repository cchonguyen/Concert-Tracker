# Session Handoff

- **Active slice:** none. M1a done (2026-10-28).
- **Last step:** Slice M1a added migration 0014 (`entities`, `entity_aliases`, `entity_links`, `entity_history`, and the event ID columns). The store now dual-writes through `withEntityLinks` (`src/server/entities/linkingStore.ts`), so every event save points its names at records. `backfillEntities` links the older events once, from the Worker cron or at local startup. Both stores enforce `entities/integrity.ts`, and `possibleDuplicates` is ready for Data health (M3b). Tests are in `tests/entities.test.ts`. The SQL was checked on a local Postgres 16: it applies, can be re-run, and its constraints reject duplicate live names, self-merges and self-links.
- **Deploy note:** 0014 is optional. Without it, events save with names only. Apply 0014 in Supabase, then deploy. The cron backfills within a minute and logs "Entity backfill: ...". A copy of the SQL is at /mnt/project-files/setup/0014_entities.sql.
- **Known cost:** each event save now reads all entities and aliases first. That is about 4 extra Supabase requests per save, which is fine at today's size. Cache it per isolate if Worker subrequests get tight.
- **Next step:** `/implement` Slice M1b: one-way sheet sync, and list import using `fillPatch` only with alias-resolved dedup.
- **Blockers:** none.
