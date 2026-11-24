// Sample data for the public demo at /demo. Every artist, festival, venue and
// person here is made up; the cities are real so the map works. This file is
// imported only by src/demo/ (tests/demo.test.ts checks that), so it is never
// part of the app's build (scripts/check-demo-isolation.mjs).
import type { LoggedEvent, SeenAct } from '../server/events/types';
import type { LineupSummary } from '../services/lineupApi';
import type { CityPoint } from '../server/events/place';

export const SAMPLE_MARKER = 'Harbor Sound Festival';
const EXAMPLE = 'https://example.com';
const stamp = '2025-06-01T12:00:00.000Z';

const act = (name: string, extra: Partial<SeenAct> = {}): SeenAct => ({
  key: name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  name,
  from: 'lineup',
  ...extra,
});

interface Show {
  id: string;
  name: string;
  startDate: string;
  endDate?: string;
  venue?: string;
  city: string;
  region?: string;
  country?: string;
  seen: SeenAct[];
  series?: string;
  weekend?: number;
  companions?: string[];
  rating?: number;
  ticketPrice?: number;
  notes?: string;
  format?: string;
  attendance?: 'planned';
  quote?: string;
  sourceUrl?: string;
  sourceType?: 'clashfinder' | 'promoter';
  weather?: LoggedEvent['weather'];
}

const show = (s: Show): LoggedEvent => {
  const [year, month] = s.startDate.split('-').map(Number);
  const sources: LoggedEvent['sources'] = {};
  if (s.sourceUrl) {
    sources.startDate = { sourceType: s.sourceType ?? 'promoter', sourceUrl: s.sourceUrl, quote: s.quote };
    sources.venue = { sourceType: s.sourceType ?? 'promoter', sourceUrl: s.sourceUrl, quote: s.quote };
  }
  return {
    id: s.id,
    name: s.name,
    input: s.name,
    year,
    month,
    startDate: s.startDate,
    endDate: s.endDate,
    venue: s.venue,
    city: s.city,
    region: s.region,
    country: s.country ?? 'United States',
    sources,
    details: { status: 'resolved', candidates: [], notes: [] },
    seen: s.seen,
    series: s.series,
    weekend: s.weekend,
    format: s.format,
    attendance: s.attendance,
    weather: s.weather,
    daysAttended: [],
    companions: s.companions ?? [],
    rating: s.rating,
    ticketPrice: s.ticketPrice,
    notes: s.notes,
    createdAt: stamp,
    updatedAt: stamp,
  };
};

const SHORE = 'Harbor Sound Festival';
const shore = (year: number, weekend: number, acts: SeenAct[], quote: string, companions: string[], rating: number) =>
  show({
    id: `harbor-${year}-w${weekend}`,
    name: `${SHORE} ${year}`,
    startDate: `${year}-06-${weekend === 1 ? '06' : '13'}`,
    endDate: `${year}-06-${weekend === 1 ? '08' : '15'}`,
    venue: 'Harbor Park',
    city: 'Portland',
    region: 'OR',
    series: SHORE,
    weekend,
    seen: acts,
    companions,
    rating,
    quote,
    sourceUrl: `${EXAMPLE}/harbor-sound/${year}/timetable`,
    sourceType: 'clashfinder',
    format: 'Outdoor festival',
    weather: {
      place: 'Portland, Oregon',
      latitude: 45.52,
      longitude: -122.68,
      days: [
        { date: `${year}-06-${weekend === 1 ? '06' : '13'}`, high: 22, low: 12, precipitation: 0, code: 1 },
        { date: `${year}-06-${weekend === 1 ? '07' : '14'}`, high: 24, low: 13, precipitation: 1.2, code: 61 },
      ],
      sourceUrl: `${EXAMPLE}/weather`,
      checkedAt: stamp,
    },
  });

export const sampleEvents: LoggedEvent[] = [
  // Three years of one festival, two weekends each: the series and streak.
  shore(2023, 1, [act('Night Tram', { role: 'headliner', favourite: true }), act('Brass Harbor'), act('Ottoline', { role: 'support' })], 'Night Tram (headliner) · Brass Harbor · Ottoline (with special guest Lumen Keys)', ['Maya', 'Sam'], 4),
  shore(2023, 2, [act('Paper Lantern Club', { role: 'headliner' }), act('Sable & Vine')], 'Paper Lantern Club headlines, Sable & Vine on the Lagoon stage', ['Maya'], 5),
  shore(2024, 1, [act('The Velvet Orchards', { role: 'headliner', favourite: true }), act('Kestrel Youth'), act('Night Tram', { role: 'support' })], 'The Velvet Orchards with special guest Kestrel Youth, Night Tram supported by ...', ['Maya', 'Sam', 'Jules'], 5),
  shore(2024, 2, [act('Coastline Static', { role: 'headliner' }), act('DJ Marrow', { set: 'dj' })], 'Coastline Static, DJ Marrow (DJ set) on the Tide stage', ['Maya', 'Sam'], 4),
  shore(2025, 1, [act('Nadia Brisk', { role: 'headliner', favourite: true }), act('Lumen Keys'), act('DJ Marrow', { set: 'dj', b2b: ['nadia brisk'] })], 'Nadia Brisk with special guest Lumen Keys; DJ Marrow b2b Nadia Brisk on Sunday', ['Maya', 'Sam', 'Jules'], 5),
  shore(2025, 2, [act('Night Tram', { role: 'headliner' }), act('Ottoline')], 'Night Tram, Ottoline on the Harbor stage', ['Sam'], 4),
  // Other festivals and concerts, with the sources they came from.
  show({ id: 'mesa-2025', name: 'Mesa Lights Festival 2025', startDate: '2025-09-19', endDate: '2025-09-20', venue: 'Canyon Field', city: 'Austin', region: 'TX', seen: [act('Velvet Orchards', { role: 'headliner' }), act('Juniper Choir'), act('Kestrel Youth', { role: 'support' })], companions: ['Jules'], rating: 4, quote: 'Mesa Lights 2025: The Velvet Orchards, Juniper Choir, Kestrel Youth', sourceUrl: `${EXAMPLE}/mesa-lights/2025`, sourceType: 'promoter', format: 'Outdoor festival', ticketPrice: 185 }),
  show({ id: 'juniper-2024', name: 'Juniper Park Weekender 2024', startDate: '2024-08-02', endDate: '2024-08-03', venue: 'Juniper Park', city: 'Chicago', region: 'IL', seen: [act('Ottoline', { role: 'headliner' }), act('Brass Harbor')], companions: ['Maya'], rating: 3, sourceUrl: `${EXAMPLE}/juniper/2024`, sourceType: 'promoter' }),
  show({ id: 'club-2025-03', name: 'Lumen Keys at Foxglove Hall', startDate: '2025-03-14', venue: 'Foxglove Hall', city: 'Los Angeles', region: 'CA', seen: [act('Lumen Keys', { role: 'headliner', favourite: true }), act('Sable & Vine', { role: 'support' })], companions: ['Sam'], rating: 5, format: 'Club night', ticketPrice: 32, notes: 'Balcony was the best spot.' }),
  show({ id: 'club-2025-06', name: 'Coastline Static', startDate: '2025-07-26', venue: 'Pier Nine', city: 'Portland', region: 'OR', seen: [act('Coastline Static', { role: 'headliner' })], companions: [], rating: 4, sourceUrl: `${EXAMPLE}/pier-nine/coastline`, sourceType: 'promoter' }),
  show({ id: 'warehouse-2024', name: 'Warehouse Night with DJ Marrow', startDate: '2024-11-08', venue: 'Brick Loft', city: 'Chicago', region: 'IL', seen: [act('DJ Marrow', { set: 'dj', favourite: true }), act('Night Tram', { set: 'live', b2b: ['dj marrow'] })], companions: ['Jules'], rating: 5, format: 'Warehouse party' }),
  show({ id: 'theatre-2024', name: 'Paper Lantern Club at The Stage', startDate: '2024-02-17', venue: 'The Stage', city: 'Austin', region: 'TX', seen: [act('Paper Lantern Club', { role: 'headliner' })], companions: ['Maya', 'Sam'], rating: 4, ticketPrice: 45 }),
  show({ id: 'arena-2023', name: 'Nadia Brisk Live', startDate: '2023-10-06', venue: 'Crest Arena', city: 'Los Angeles', region: 'CA', seen: [act('Nadia Brisk', { role: 'headliner' }), act('Ottoline', { role: 'support' })], companions: [], rating: 3, ticketPrice: 70 }),
  show({ id: 'rooftop-2025', name: 'Brass Harbor Rooftop Set', startDate: '2025-05-23', venue: 'Skyline Rooftop', city: 'Brooklyn', region: 'NY', seen: [act('Brass Harbor', { role: 'headliner' })], companions: ['Jules'], rating: 4, format: 'Rooftop set', notes: 'Set times were not published.' }),
  show({ id: 'ballroom-2024', name: 'Velvet Orchards', startDate: '2024-09-28', venue: 'Grand Ballroom', city: 'Chicago', region: 'IL', seen: [act('The Velvet Orchards', { role: 'headliner' })], companions: ['Sam'], rating: 4 }),
  show({ id: 'indoor-2023', name: 'Juniper Choir Winter Concert', startDate: '2023-12-09', venue: 'Old Hall', city: 'Portland', region: 'OR', seen: [act('Juniper Choir', { role: 'headliner' })], companions: [] }),
  show({ id: 'festival-2022', name: 'Desert Sun Weekend 2022', startDate: '2022-04-22', endDate: '2022-04-24', venue: 'Dune Fields', city: 'Austin', region: 'TX', seen: [act('Night Tram'), act('Coastline Static')], companions: ['Maya'], rating: 3 }),
  show({ id: 'missing-2025', name: 'Sable & Vine', startDate: '2025-08-30', city: 'Austin', region: 'TX', seen: [act('Sable & Vine', { role: 'headliner' })], companions: [] }),
  // Upcoming: a planned show, and one waiting for you to confirm.
  show({ id: 'upcoming-2026', name: 'Kestrel Youth at Harbor Hall', startDate: '2026-02-21', venue: 'Harbor Hall', city: 'Portland', region: 'OR', seen: [act('Kestrel Youth', { role: 'headliner' })], companions: ['Maya'], attendance: 'planned', sourceUrl: `${EXAMPLE}/harbor-hall/2026`, sourceType: 'promoter' }),
  show({ id: 'upcoming-2026-b', name: 'Mesa Lights Festival 2026', startDate: '2026-09-18', endDate: '2026-09-19', venue: 'Canyon Field', city: 'Austin', region: 'TX', seen: [], companions: [], attendance: 'planned' }),
  show({ id: 'festival-2024-b', name: 'Coastline Summer Fest 2024', startDate: '2024-07-13', venue: 'Pier Nine Lawn', city: 'Portland', region: 'OR', seen: [act('Coastline Static', { role: 'headliner' }), act('Juniper Choir')], companions: ['Sam', 'Jules'], rating: 4, format: 'Outdoor festival' }),
  show({ id: 'club-2023-b', name: 'Night Tram at The Lantern', startDate: '2023-03-31', venue: 'The Lantern', city: 'Chicago', region: 'IL', seen: [act('Night Tram', { role: 'headliner' })], companions: ['Maya'], rating: 5 }),
  show({ id: 'lantern-2024', name: 'Lantern Sessions 2024', startDate: '2024-05-18', endDate: '2024-05-19', venue: 'Lantern Lawn', city: 'Los Angeles', region: 'CA', seen: [act('Paper Lantern Club', { role: 'headliner' }), act('Lumen Keys', { role: 'support' }), act('Brass Harbor')], companions: ['Jules'], rating: 4, format: 'Outdoor festival', sourceUrl: `${EXAMPLE}/lantern-sessions/2024`, sourceType: 'promoter' }),
  show({ id: 'acoustic-2025', name: 'Night Tram Acoustic at Mill Room', startDate: '2025-01-25', venue: 'Mill Room', city: 'Brooklyn', region: 'NY', seen: [act('Night Tram', { role: 'headliner' })], companions: ['Sam'], rating: 4 }),
  show({ id: 'club-2025-b', name: 'Ottoline Acoustic Night', startDate: '2025-10-11', venue: 'Mill Room', city: 'Brooklyn', region: 'NY', seen: [act('Ottoline', { role: 'headliner' })], companions: [], rating: 4 }),
];

// The lineups the app read for each event, as a status and an act count. The
// sample sources are "example.com" pages; no lineup is looked up.
export const sampleLineups: Record<string, LineupSummary> = Object.fromEntries(
  sampleEvents.map((e) => [e.id, { jobId: `demo-${e.id}`, status: 'done' as LineupSummary['status'], actCount: e.seen.length }]),
);

// Coordinates for the cities in the sample, so the map does not ask the server.
export const samplePoints: Record<string, CityPoint> = {
  Portland: { lat: 45.52, lon: -122.68, match: 'exact' },
  Austin: { lat: 30.27, lon: -97.74, match: 'exact' },
  Chicago: { lat: 41.88, lon: -87.63, match: 'exact' },
  'Los Angeles': { lat: 34.05, lon: -118.24, match: 'exact' },
  Brooklyn: { lat: 40.65, lon: -73.95, match: 'exact' },
};
