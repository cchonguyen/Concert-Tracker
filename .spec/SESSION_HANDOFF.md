# Session Handoff

- **Active slice:** none. M2b done (2026-10-28).
- **Last step:** M2b added the Manage tab (`src/components/ManageView.tsx`, `ManageEntry.tsx`): a list per kind (Artists, People, Venues, Places, Series, Organizations) with event counts, look-alike badges and search; a record page with Rename everywhere, AKAs, Merge into (confirmed, with look-alike offers and a "Merge into" button on a name conflict), venue place, series Hosted by, organization's series, and the record's events; an Undo notice after each change and a History list. The Series panel is embedded in Manage's Series list (rename goes through the series record); the Table's Series button opens it. The Artists tab cards (In Manage) and the event view (Edit on every event in Manage) link in. Checked in a browser on a scratch file store: merge, rename, history and undo all work, and the page fits a phone.
- **Deploy note:** no migration beyond 0014. Without 0014 the Manage tab shows the 503 message.
- **Known limits:** AKAs show normalized (lower case). Artists in an event aren't linked from the event view (the Artists tab covers them).
- **Next step:** `/implement` Slice M3a: venue → place.
- **Blockers:** none.
