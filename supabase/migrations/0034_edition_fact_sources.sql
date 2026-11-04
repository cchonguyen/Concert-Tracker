-- Edition facts editable with a source note (Global Archive, GA4).
-- Additive and idempotent. Not applied by the repo: the owner applies it.
-- fact_source_note is admin-curated fact provenance: the owner's note saying where the
-- edition's name, dates, venue or city came from. It is free text, never filled in by code.
alter table event_editions add column if not exists fact_source_note text;
comment on column event_editions.fact_source_note is 'Admin-curated fact provenance: the owner''s source note for the edition''s name, dates, venue and city. Null until the owner edits a fact.';
