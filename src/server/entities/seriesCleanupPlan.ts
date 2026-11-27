import type { CleanupStep } from './seriesCleanup';

// The current one-time series cleanup list, run by the owner from Global Archive through runSeriesCleanup
// (docs/specs/series-cleanup.md). One-time data, like a data migration: slugs come from the live records read
// on the day it was written. Nothing matches against it, so it is not a hardcoded festival or artist list.
// Once it has run and the read-only check passes, the list is emptied and the Global Archive panel hides.
//
// 2026-11-27, second list (Charlie: "The eight series do have stored acts."): the first loose-ends list of the day has run.
// Each tour below takes as its brand the act stored on Charlie's own event of the same name, and its old name
// becomes the qualifier. KCON LA 2025 gets the series its event names.
const festival = 'festival' as const;
const tour = 'tour' as const;

export const SERIES_CLEANUP_PLAN: CleanupStep[] = [
  // Tours whose brand is the one act on the event.
  { op: 'series', slug: 'alive', brand: 'Daft Punk', qualifier: 'Alive', aliases: ['Alive'] },
  { op: 'series', slug: 'anti-world-tour', brand: 'Rihanna', qualifier: 'Anti World Tour', aliases: ['Anti World Tour'] },
  { op: 'series', slug: 'new-evolution-global-tour', brand: '2NE1', qualifier: 'New Evolution Global Tour', aliases: ['New Evolution Global Tour'] },
  { op: 'series', slug: 'tension-tour', brand: 'Kylie Minogue', qualifier: 'Tension Tour', aliases: ['Tension Tour'] },
  { op: 'series', slug: 'the-monster-ball-tour', brand: 'Lady Gaga', qualifier: 'The Monster Ball Tour', aliases: ['The Monster Ball Tour'] },
  { op: 'series', slug: 'griff', brand: 'Griff', qualifier: 'Vertigo', aliases: ['Vertigo', 'Vertigo World Tour'] },
  // A one-act residency stored as a festival.
  { op: 'series', slug: 'vegas-residency', brand: 'Zedd', qualifier: 'Vegas Residency', kind: tour, aliases: ['Vegas Residency'] },
  // A multi-act night: the brand is its name, the place its qualifier.
  { op: 'series', slug: 'double-u-los-angeles', brand: 'Double-u', qualifier: 'Los Angeles', kind: festival, aliases: ['Double-u los angeles'] },
  // KCON LA 2025 has no series; its event names "KCON".
  { op: 'series', slug: 'kcon-la', create: true, name: 'KCON LA', brand: 'KCON', qualifier: 'LA', kind: festival, aliases: ['KCON'] },
  { op: 'edition', id: '62e634eb-bae1-4080-9c5c-b6ea384a12ef', seriesSlug: 'kcon-la' },
  { op: 'linkEvents' },
];
