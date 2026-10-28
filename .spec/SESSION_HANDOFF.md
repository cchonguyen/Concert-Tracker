# Session Handoff

- **Active slice:** none. M1b done (2026-10-28).
- **Last step:** M1b made Google Sheets sync one-way. "Update the sheet" writes your log into the tab. When rows were edited, added or removed in the sheet since the last write (`outsideEdits` in `src/services/sheetSync.ts`), or own columns would be dropped, it asks before replacing them. Nothing is read back. `editPatch` and its three-way merge are gone. Rows from the app's own export (with an ID) fold into their event through `fillPatch`, which only fills gaps. `fillPatch` takes a `NameIndex` from the new `GET /api/entities/names` (`src/server/entities/routes.ts`), so an act or person already on the event under an alias is not added twice. REQUIREMENTS R4.9 and R4.12 and ARCHITECTURE ("Importing a list", "Google Sheets sync") are updated.
- **Deploy note:** no migration. Alias dedup only works once 0014 is applied; without it, names compare as written.
- **Next step:** `/implement` Slice M2a: Manage operations (rename, merge with flattening and link/act/companion dedup, AKA add and remove, history manifest and undo, API routes).
- **Blockers:** none.
