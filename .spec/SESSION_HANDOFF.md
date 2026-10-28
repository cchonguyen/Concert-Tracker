# Session Handoff

- **Active slice:** none. Share page S1 done (2026-10-28); Manage M2a done by its own thread (2026-10-28).
- **Last step (Share S1):** migration 0015 `share_links` (not yet applied in Supabase); `src/server/share/` (types, `buildShareView` allow-list, `isOver`/`todayIn` in the link's time zone, link codes stored as SHA-256 hashes, one active link); store methods `listShareLinks`, `getShareLinkByHash`, `putShareLink`, `listShareEvents` (named columns only) in both stores; `tests/share.test.ts`.
- **Last step (Manage M2a):** Manage operations in `src/server/entities/manage.ts` and routes under `/api/entities`; store primitives `putEntities`, `replaceEntityAliases`, `replaceEntityLinks`, entity history; no new migration (uses 0014).
- **Next steps:** Share: `/implement` Slice S2 (strict raw-path match and Access token check at the top of `worker/index.ts`, GET/HEAD `/s/:code`, headers, "not active" page, `/s/*` in `run_worker_first`). Manage: Slice M2b (Manage tab UI).
- **Blockers:** Share S4 needs Charlie: Access team domain and audience tag, Access bypass app on `/s/*`, migration 0015, deploy from the Mac.
