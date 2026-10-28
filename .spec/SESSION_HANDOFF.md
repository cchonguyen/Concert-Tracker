# Session Handoff

- **Active slice:** none. M2a done (2026-10-28).
- **Last step:** M2a added the Manage operations in `src/server/entities/manage.ts` and their routes under `/api/entities` (`routes.ts`): rename, merge (flattened; AKAs and links moved with duplicates dropped; acts and companions on one event combined, target's marks first), AKA add and remove, links (venue `in` one place, series `hosted_by` organizations), and adding an organization. Rename and merge rewrite event names (dual-write). Each change writes a `HistoryEntry` manifest first; `undoEntry` restores it, skips events changed since, and refuses while a later change touched the same records. New store primitives in both stores: `putEntities`, `replaceEntityAliases`, `replaceEntityLinks`, entity history. Client calls: `entitiesApi` in `src/services/lineupApi.ts`. Tests: `tests/manage.test.ts`.
- **Deploy note:** no new migration (uses 0014). Without 0014 the Manage routes answer 503.
- **Known limits:** Supabase alias and link replacement are separate requests (not one transaction); the history entry written first holds what to restore. A renamed artist's new key no longer matches an old spelling in a canonical lineup's review.
- **Next step:** `/implement` Slice M2b: the Manage tab UI.
- **Blockers:** none.
