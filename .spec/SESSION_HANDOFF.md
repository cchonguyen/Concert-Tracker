# Session Handoff

- **Active slice:** none. Share page S1 (PR #57) and S2 (PR #60) merged; S3 done (2026-10-28).
- **Last step (Share S3):** owner controls at `/api/share` (`src/server/share/routes.ts`: status, create, settings, turn off, preview) and `SharePanel.tsx` behind a Share button in Stats. The full link is kept only in the making browser's localStorage (`share-link`). Tests: `tests/shareApi.test.ts`.
- **Earlier (Share S2):** `src/server/share/door.ts` runs first in `worker/index.ts`: any `/s` path answered there (GET/HEAD exact code -> page, else identical 404); `page.ts` renders script-free escaped HTML with the spec headers; `access.ts` verifies the Access JWT on every other request when `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are set. `downloadText` moved to `src/services/download.ts` so the Worker can load `format.ts`. Tests: `tests/shareRoute.test.ts`.
- **Last step (Manage M2a):** Manage operations in `src/server/entities/manage.ts` and routes under `/api/entities`; store primitives `putEntities`, `replaceEntityAliases`, `replaceEntityLinks`, entity history; no new migration (uses 0014).
- **Next steps:** Share: Slice S4 (release, needs Charlie and the Mac). Manage: Slice M2b (Manage tab UI).
- **Blockers:** Share S4 needs Charlie: Access team domain and audience tag, Access bypass app on `/s/*`, migration 0015, deploy from the Mac.
