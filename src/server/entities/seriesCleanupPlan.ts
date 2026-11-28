import type { CleanupStep } from './seriesCleanup';

// The current one-time series cleanup list, run by the owner from Global Archive through runSeriesCleanup
// (docs/archive/series-cleanup.md). One-time data, like a data migration: slugs come from the live records read
// on the day it was written. Nothing matches against it, so it is not a hardcoded festival or artist list.
// Once it has run and the read-only check passes, the list is emptied and the Global Archive panel hides.
//
// 2026-11-28: the second list (2026-11-27) has run; a read-only check found every series it names with its brand and
// qualifier, and KCON LA created. The list is empty, so the panel hides. Series health (seriesHealth.ts) checks from here on.
export const SERIES_CLEANUP_PLAN: CleanupStep[] = [];
