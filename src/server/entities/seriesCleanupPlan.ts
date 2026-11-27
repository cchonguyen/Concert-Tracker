import type { CleanupStep } from './seriesCleanup';

// The current one-time series cleanup list, run by the owner from Global Archive through runSeriesCleanup
// (docs/specs/series-cleanup.md). One-time data, like a data migration: slugs come from the live records read
// on the day it was written. Nothing matches against it, so it is not a hardcoded festival or artist list.
// Once it has run and the read-only check passes, the list is emptied and the Global Archive panel hides.
//
// 2026-11-27 (Charlie: "Clean up the loose ends. The goal is to have data consistency."): every series name is
// built from its brand and its qualifier, so a place or tour title written into a name moves into the qualifier.
const festival = 'festival' as const;

export const SERIES_CLEANUP_PLAN: CleanupStep[] = [
  // Places and event words that were written into the name: the shown name stays the same.
  { op: 'series', slug: 'dreamstate-socal', qualifier: 'SoCal' },
  { op: 'series', slug: 'dreamstate-san-francisco', qualifier: 'San Francisco' },
  { op: 'series', slug: 'dreamstate-vancouver', qualifier: 'Vancouver' },
  { op: 'series', slug: 'edc-las-vegas', qualifier: 'Las Vegas' },
  { op: 'series', slug: 'edc-pool-party', qualifier: 'Pool Party' },
  { op: 'series', slug: 'day-trip-feat-westend-justin-martin-dansyn-marta', qualifier: 'LA' },
  { op: 'series', slug: 'white-party-bangkok', qualifier: 'Bangkok' },
  { op: 'series', slug: 'beyond-wonderland-pnw', qualifier: 'PNW' },
  { op: 'series', slug: 'countdown-nye', qualifier: 'NYE' },
  { op: 'series', slug: 'above-and-beyond-group-therapy-700', qualifier: 'Group Therapy Weekender' },
  // Names that change to the shared pattern (the old name is kept as an alias, beside the aliases already there): "Brand Place" for a festival, "Artist: Tour" for a tour.
  { op: 'series', slug: 'outloud-music-festival-in-west-hollywood', qualifier: 'West Hollywood', aliases: ['Outloud', 'Outloud Pride', 'Outloud Music Festival', 'OUTLOUD Music Festival in West Hollywood'] },
  { op: 'series', slug: 'illenium-gorge', qualifier: 'The Gorge', aliases: ['Illenium @ the Gorge', 'Illenium at the Gorge'] },
  { op: 'series', slug: 'kx5-la-memorial-coliseum', qualifier: 'Kx5', aliases: ['Kx5'] },
  { op: 'series', slug: 'our-house-meduza-and-james-hype-ages-18-with-valid-id', qualifier: 'Our House', aliases: ['Our House'] },
  // Series with a stored lineup of many acts and no kind yet.
  { op: 'series', slug: 'breakaway-music-festival-bay-area', kind: festival },
  { op: 'series', slug: 'veld', kind: festival },
  { op: 'series', slug: 'planet-pride', kind: festival },
  // Series with no brand: the brand is the series' own name.
  { op: 'series', slug: 'insomnia', brand: 'Insomnia' },
  { op: 'series', slug: 'agents-of-time-henri-bergmann', brand: 'Agents of Time, Henri Bergmann' },
  { op: 'series', slug: 'porter-robinson-and-ninajirachi', brand: 'Porter Robinson & Ninajirachi' },
  { op: 'series', slug: 'telykast-x-dubvision', brand: 'Telykast x DubVision' },
  { op: 'linkEvents' },
];
