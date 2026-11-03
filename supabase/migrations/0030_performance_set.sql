-- 0030_performance_set.sql
-- Add set modifier column to performances (e.g. DJ Set, Live, Sunrise Set, etc.)

alter table performances add column if not exists set text;
