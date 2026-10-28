# Session Handoff

- **Active slice:** none. Share page S1 merged (PR #57) and S2 done (2026-10-28).
- **Last step (Share S2):** `src/server/share/door.ts` runs first in `worker/index.ts`: any `/s` path answered there (GET/HEAD exact code -> page, else identical 404); `page.ts` renders script-free escaped HTML with the spec headers; `access.ts` verifies the Access JWT on every other request when `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are set. `downloadText` moved to `src/services/download.ts` so the Worker can load `format.ts`. Tests: `tests/shareRoute.test.ts`.
- **Last step (Manage M2a):** Manage operations in `src/server/entities/manage.ts` and routes under `/api/entities`; store primitives `putEntities`, `replaceEntityAliases`, `replaceEntityLinks`, entity history; no new migration (uses 0014).
- **Next steps:** Share: `/implement` Slice S3 (Share panel in Stats, locked `/api/share` routes). Manage: Slice M2b (Manage tab UI).
- **Blockers:** Share S4 needs Charlie: Access team domain and audience tag, Access bypass app on `/s/*`, migration 0015, deploy from the Mac.
