-- Auto-verify status for shared acts (docs/auto-verify-spec.md, slice 3a).
-- 'verified' is the default, because every act stored before this change came from an owner entry,
-- a ticket email or a canonical ingest. A member's own tick is written as 'candidate' (slice 5).
-- Written, not applied: Charlie applies it, then the code that writes the column can ship.
alter table performances add column if not exists verification text not null default 'verified'
  check (verification in ('candidate', 'verified'));
