import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoggedEvent } from '../src/server/events/types.ts';
import type { ArtistGenres, GenreVocabulary } from '../src/server/events/genreTypes.ts';
import { genresByArtist } from '../src/services/genres.ts';
import {
  artistsBehind,
  comingUp,
  cooling,
  goneQuiet,
  periodEvents,
  rising,
} from '../src/services/genreInsights.ts';

const TODAY = '2026-11-26';

function ev(id: string, startDate: string | undefined, seenNames: string[], extra: Partial<LoggedEvent> = {}): LoggedEvent {
  return {
    id,
    input: extra.name ?? `Event ${id}`,
    name: extra.name ?? `Event ${id}`,
    startDate,
    sources: {},
    details: { status: 'resolved', candidates: [], notes: [] },
    seen: seenNames.map((name) => ({ key: name.toLowerCase(), name, from: 'you' as const })),
    daysAttended: [],
    companions: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function artist(name: string, genres: Array<{ parent: string; style: string; weight: number }>, source: ArtistGenres['source'] = 'owner'): ArtistGenres {
  return {
    key: name.toLowerCase(),
    name,
    source,
    genres,
    checkedAt: '2026-01-01T00:00:00Z',
  };
}

test('periodEvents filters by all, exact 365-day last12 window, year, and ignores planned/missed', () => {
  const events = [
    ev('in-boundary', '2025-11-27', ['A']), // exactly 365 days ending 2026-11-26
    ev('out-boundary', '2025-11-26', ['A']), // 366th day back -> outside last12
    ev('month-only', undefined, ['A'], { year: 2026, month: 4 }),
    ev('planned', '2026-12-10', ['A'], { attendance: 'planned' }),
    ev('missed', '2026-05-01', ['A'], { attendance: 'missed' }),
  ];

  assert.deepEqual(periodEvents(events, 'all', TODAY).map((e) => e.id), ['in-boundary', 'out-boundary', 'month-only']);
  assert.deepEqual(periodEvents(events, 'last12', TODAY).map((e) => e.id), ['in-boundary', 'month-only']);
  assert.deepEqual(periodEvents(events, 2026, TODAY).map((e) => e.id), ['month-only']);
  assert.deepEqual(periodEvents(events, 2025, TODAY).map((e) => e.id), ['in-boundary', 'out-boundary']);
});

test('artistsBehind ranks by weighted share, breaks ties by name, includes member added genres, and ignores planned/missed', () => {
  const rows: ArtistGenres[] = [
    artist('Zed', [{ parent: 'Electronic', style: 'Techno', weight: 0.5 }, { parent: 'Electronic', style: 'House', weight: 0.5 }]),
    artist('Alpha', [{ parent: 'Electronic', style: 'Techno', weight: 0.5 }, { parent: 'Electronic', style: 'Trance', weight: 0.5 }]),
    artist('Beta', [{ parent: 'Electronic', style: 'Deep House', weight: 1 }], 'music-story'),
    artist('Beta', [{ parent: 'Electronic', style: 'Techno', weight: 1 }], 'added'),
    artist('Gamma', [{ parent: 'Electronic', style: 'Techno', weight: 1 }]),
  ];
  const vocab: GenreVocabulary = {
    genres: [
      { key: 'electronic', name: 'Electronic', aliases: [], umbrellas: [] },
      { key: 'techno', name: 'Techno', parent: 'Electronic', aliases: [], umbrellas: ['electronic'] },
    ],
  };
  const byArtist = genresByArtist(rows, vocab);
  const events = [
    ev('1', '2026-03-01', ['Zed', 'Alpha']),
    ev('2', undefined, ['Beta'], { year: 2026, month: 6 }),
    ev('3', '2026-07-01', ['Gamma'], { attendance: 'missed' }),
    ev('4', '2026-12-01', ['Gamma'], { attendance: 'planned' }),
  ];

  // Alpha & Zed tie at 0.5 -> Alpha before Zed; Beta has 0.5 via member 'added' Techno
  const behindTechno = artistsBehind(events, byArtist, vocab, { kind: 'style', name: 'Techno' });
  assert.deepEqual(behindTechno.map((r) => [r.name, r.weightedSets, r.lastSeen]), [
    ['Alpha', 0.5, '2026-03-01'],
    ['Beta', 0.5, '2026-06'],
    ['Zed', 0.5, '2026-03-01'],
  ]);

  const behindGroup = artistsBehind(events, byArtist, vocab, { kind: 'group', name: 'Electronic' });
  assert.equal(behindGroup.length, 3);
  assert.equal(behindGroup[0].weightedSets, 1);
});

test('rising enforces 5 sets across 3 events, doubling or +10pt share gain, umbrella-child dedupe, cap 4, and top 2 artists', () => {
  const vocab: GenreVocabulary = {
    genres: [
      { key: 'bass', name: 'Bass', parent: 'Electronic', aliases: [], umbrellas: [] },
      { key: 'drumandbass', name: 'Drum & bass', parent: 'Electronic', aliases: [], umbrellas: ['bass'] },
    ],
  };
  const byArtist = genresByArtist(
    [
      artist('Rainmetre', [{ parent: 'Electronic', style: 'Drum & bass', weight: 1 }]),
      artist('Vesper Lane', [{ parent: 'Electronic', style: 'Drum & bass', weight: 1 }]),
      artist('Sidekick', [{ parent: 'Electronic', style: 'Drum & bass', weight: 1 }]),
      artist('FewEvents', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
      artist('FourSets', [{ parent: 'Electronic', style: 'Ambient', weight: 1 }]),
      artist('ShareGain', [{ parent: 'Electronic', style: 'Garage', weight: 1 }]),
      artist('FlatAct', [{ parent: 'Electronic', style: 'Disco', weight: 1 }]),
    ],
    vocab,
  );

  const events: LoggedEvent[] = [
    // Previous 12 months: 2024-11-27 .. 2025-11-26
    ev('p1', '2025-02-01', ['Rainmetre', 'Vesper Lane']), // 2 D&B before
    ...Array.from({ length: 10 }, (_, i) => ev(`pg-${i}`, `2025-03-0${(i % 9) + 1}`, ['ShareGain'])), // 10 Garage before
    ...Array.from({ length: 20 }, (_, i) => ev(`pf-${i}`, `2025-04-0${(i % 9) + 1}`, ['FlatAct'])), // 20 Disco before (high base -> Garage share was ~31%)

    // Recent 12 months: 2025-11-27 .. 2026-11-26
    // D&B: 5 sets across 3 events (doubled 2 -> 5): Rainmetre x3, Vesper Lane x2, Sidekick x1 -> 6 sets across 3 events
    ev('r1', '2026-01-01', ['Rainmetre', 'Vesper Lane']),
    ev('r2', '2026-02-01', ['Rainmetre', 'Sidekick']),
    ev('r3', '2026-03-01', ['Rainmetre', 'Vesper Lane']),
    // House: 5 sets across only 2 events -> should NOT qualify
    ev('h1', '2026-04-01', ['FewEvents', 'FewEvents', 'FewEvents']),
    ev('h2', '2026-04-02', ['FewEvents', 'FewEvents']),
    // Ambient: 4 sets across 4 events -> should NOT qualify
    ev('a1', '2026-05-01', ['FourSets']),
    ev('a2', '2026-05-02', ['FourSets']),
    ev('a3', '2026-05-03', ['FourSets']),
    ev('a4', '2026-05-04', ['FourSets']),
    // Garage: 15 sets across 3 events (not doubled 10 -> 15, but share jumped > 10 points from 10/32=31.25% to 15/30=50%)
    ev('g1', '2026-06-01', ['ShareGain', 'ShareGain', 'ShareGain', 'ShareGain', 'ShareGain']),
    ev('g2', '2026-06-02', ['ShareGain', 'ShareGain', 'ShareGain', 'ShareGain', 'ShareGain']),
    ev('g3', '2026-06-03', ['ShareGain', 'ShareGain', 'ShareGain', 'ShareGain', 'ShareGain']),
  ];

  const res = rising(events, byArtist, vocab, TODAY);
  // Bass umbrella should be dropped because child Drum & bass qualifies
  assert.deepEqual(res.items.map((x) => x.name), ['Garage', 'Drum & bass']);
  assert.equal(res.items[1].beforeSets, 2);
  assert.equal(res.items[1].recentSets, 6);
  assert.deepEqual(res.items[1].topArtists.map((a) => a.name), ['Rainmetre', 'Vesper Lane']);
  assert.equal(res.recentKnownSets, 30);
});

test('cooling requires >= 5 sets before and <= half after, capped at 2', () => {
  const byArtist = genresByArtist([
    artist('TranceAct', [{ parent: 'Electronic', style: 'Trance', weight: 1 }]),
    artist('FourBefore', [{ parent: 'Electronic', style: 'Breakbeat', weight: 1 }]),
    artist('SlightlyDown', [{ parent: 'Electronic', style: 'Dubstep', weight: 1 }]),
  ]);

  const events: LoggedEvent[] = [
    // Previous: 6 Trance, 4 Breakbeat, 5 Dubstep
    ...Array.from({ length: 6 }, (_, i) => ev(`pt-${i}`, `2025-01-0${i + 1}`, ['TranceAct'])),
    ...Array.from({ length: 4 }, (_, i) => ev(`pb-${i}`, `2025-02-0${i + 1}`, ['FourBefore'])),
    ...Array.from({ length: 5 }, (_, i) => ev(`pd-${i}`, `2025-03-0${i + 1}`, ['SlightlyDown'])),
    // Recent: 3 Trance (<= 6/2 -> qualifies), 0 Breakbeat (<5 before -> no), 3 Dubstep (> 5/2 -> no)
    ...Array.from({ length: 3 }, (_, i) => ev(`rt-${i}`, `2026-01-0${i + 1}`, ['TranceAct'])),
    ...Array.from({ length: 3 }, (_, i) => ev(`rd-${i}`, `2026-02-0${i + 1}`, ['SlightlyDown'])),
  ];

  const res = cooling(events, byArtist, undefined, TODAY);
  assert.deepEqual(res, [
    { key: 'trance', name: 'Trance', kind: 'style', beforeSets: 6, recentSets: 3 },
  ]);
});

test('goneQuiet enforces 5-set minimum and exact 18-month cutoff, and handles month-only dates', () => {
  const byArtist = genresByArtist([
    artist('Halcyon Drift', [{ parent: 'Electronic', style: 'Trance', weight: 1 }]),
    artist('RecentEnough', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('TooFew', [{ parent: 'Electronic', style: 'Ambient', weight: 1 }]),
  ]);

  // 18 months before 2026-11-26 is 2025-05-26
  const events: LoggedEvent[] = [
    ...Array.from({ length: 5 }, (_, i) =>
      ev(`tr-${i}`, i === 4 ? '2025-05-26' : `2024-01-0${i + 1}`, ['Halcyon Drift'], { name: i === 4 ? 'Dreamfields' : `Show ${i}` }),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      ev(`ho-${i}`, i === 4 ? '2025-05-27' : `2024-02-0${i + 1}`, ['RecentEnough']),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      ev(`am-${i}`, `2024-03-0${i + 1}`, ['TooFew']),
    ),
  ];

  const q = goneQuiet(events, byArtist, undefined, TODAY);
  assert.ok(q);
  assert.equal(q.name, 'Trance');
  assert.equal(q.sets, 5);
  assert.equal(q.lastDate, '2025-05-26');
  assert.equal(q.lastEvent, 'Dreamfields');
  assert.equal(q.lastAct, 'Halcyon Drift');

  // Month-only date sorts at start of month without fabricating a day
  const monthOnlyEvents = Array.from({ length: 5 }, (_, i) =>
    ev(`mo-${i}`, i === 4 ? undefined : `2024-01-0${i + 1}`, ['Halcyon Drift'], i === 4 ? { year: 2025, month: 5, name: 'May Fest' } : {}),
  );
  const qMonth = goneQuiet(monthOnlyEvents, byArtist, undefined, TODAY);
  assert.ok(qMonth);
  assert.equal(qMonth.lastDate, '2025-05');
  assert.equal(qMonth.lastSortDate, '2025-05-01');
});

test('comingUp reads only upcoming planned events, caps at 3, and attaches firstSince', () => {
  const byArtist = genresByArtist([
    artist('Mira Vale', [{ parent: 'Electronic', style: 'Techno', weight: 1 }]),
    artist('Act B', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('Act C', [{ parent: 'Electronic', style: 'Trance', weight: 1 }]),
    artist('Act D', [{ parent: 'Electronic', style: 'Ambient', weight: 1 }]),
  ]);

  const events: LoggedEvent[] = [
    ev('past-went', '2026-10-01', ['Mira Vale']),
    ev('past-planned', '2026-10-15', ['Act B'], { attendance: 'planned' }), // confirm, not upcoming
    ev('missed', '2026-12-01', ['Act C'], { attendance: 'missed' }),
    ev('u2', '2026-12-20', ['Act B', 'Act C'], { attendance: 'planned', venue: 'Club B' }),
    ev('u1', '2026-12-05', ['Mira Vale'], { attendance: 'planned', venue: 'The Foundry' }),
    ev('u3', '2027-01-10', ['Act D'], { attendance: 'planned', venue: 'Hall D' }),
  ];

  const quietSince = new Map([['techno', '2025-03-10']]);
  const res = comingUp(events, byArtist, undefined, TODAY, quietSince);
  assert.deepEqual(res.map((x) => [x.name, x.actName, x.venue, x.firstSince]), [
    ['Techno', 'Mira Vale', 'The Foundry', '2025-03-10'],
    ['House', 'Act B', 'Club B', undefined],
    ['Trance', 'Act C', 'Club B', undefined],
  ]);
});
