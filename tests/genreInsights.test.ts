import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoggedEvent } from '../src/server/events/types.ts';
import type { ArtistGenres, GenreVocabulary, VocabGenre } from '../src/server/events/genreTypes.ts';
import { genreMix, genresByArtist } from '../src/services/genres.ts';
import {
  artistsBehind,
  comingUp,
  cooling,
  genreByKind,
  genreBySeason,
  genreByYear,
  genreFirsts,
  genreLabel,
  genreZoom,
  ZOOM_MIN_SETS,
  genreMilestones,
  genreRange,
  genreStoryLine,
  genreTree,
  goneQuiet,
  newThisYear,
  peopleGenres,
  periodEvents,
  rising,
  yearGenres,
  soundDrift,
  driftDrivers,
  DRIFT_MIN_SETS,
  DRIFT_MIN_YEARS,
  DRIFT_BANDS,
  lineupDna,
  LINEUP_DNA_MIN_ACTS,
  eventMatch,
  MATCH_ALPHA,
  MATCH_MIN_EVENTS,
  MATCH_MIN_SETS,
} from '../src/services/genreInsights.ts';
import type { LineupGenresAct } from '../src/services/lineupApi.ts';
import { genreKey } from '../src/server/events/genreVocabulary.ts';

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

function artist(name: string, genres: Array<{ parent: string; style: string; weight: number }>, source: ArtistGenres['source'] = 'music-story'): ArtistGenres {
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

// Marks every act in the event as B2B with the others in it (docs/specs/genre-taxonomy-release-1.md section 1).
const b2bEvent = (e: LoggedEvent): LoggedEvent => ({
  ...e,
  seen: e.seen.map((s) => ({ ...s, b2b: e.seen.filter((x) => x.key !== s.key).map((x) => x.key) })),
});

test('artistsBehind counts a B2B act half a set, and goneQuiet compares its floor on the fractional total', () => {
  const rows: ArtistGenres[] = [
    artist('Zed', [{ parent: 'Electronic', style: 'Techno', weight: 1 }]),
    artist('Alpha', [{ parent: 'Electronic', style: 'Techno', weight: 1 }]),
  ];
  const byArtist = genresByArtist(rows);
  const b2b = b2bEvent(ev('1', '2026-03-01', ['Zed', 'Alpha']));
  const behind = artistsBehind([b2b], byArtist, undefined, { kind: 'style', name: 'Techno' });
  assert.deepEqual(behind.map((r) => [r.name, r.weightedSets, r.sets]), [
    ['Alpha', 0.5, 0.5],
    ['Zed', 0.5, 0.5],
  ]);

  // Halcyon Drift in nine B2B nights is 4.5 sets: under the 5-set floor. A tenth night makes 5.
  const halcyon = genresByArtist([artist('Halcyon Drift', [{ parent: 'Electronic', style: 'Trance', weight: 1 }])]);
  const nights = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      b2bEvent(ev(`tr-${i}`, `2024-01-${String(i + 1).padStart(2, '0')}`, ['Halcyon Drift', 'Partner'])),
    );
  assert.equal(goneQuiet(nights(9), halcyon, undefined, TODAY), null);
  const q = goneQuiet(nights(10), halcyon, undefined, TODAY);
  assert.ok(q);
  assert.equal(q.sets, 5);
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

test('genreFirsts orders oldest first, handles month-only dates and ties, and newThisYear picks current year', () => {
  const byArtist = genresByArtist([
    artist('Zed', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('Alpha', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('Beta', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('RockAct', [{ parent: 'Rock', style: 'Indie Rock', weight: 1 }]),
    artist('FreshAct', [{ parent: 'Jazz', style: 'Nu Jazz', weight: 1 }]),
  ]);

  const events = [
    ev('e1', undefined, ['RockAct'], { year: 2018, month: 5, name: 'May Rock' }),
    ev('e2', '2012-06-14', ['Zed', 'Alpha', 'Beta'], { name: 'Early Fest' }),
    ev('e3', '2026-04-18', ['FreshAct'], { name: 'Spring Jazz' }),
  ];

  const firsts = genreFirsts(events, byArtist, undefined, TODAY);
  assert.equal(firsts.knownSets, 5);
  assert.deepEqual(firsts.items.map((i) => [i.group, i.year, i.acts, i.moreCount]), [
    ['Electronic', 2012, ['Alpha', 'Beta'], 1],
    ['Rock', 2018, ['RockAct'], 0],
    ['Jazz', 2026, ['FreshAct'], 0],
  ]);

  const nty = newThisYear(events, byArtist, undefined, TODAY);
  assert.deepEqual(nty.map((x) => [x.name, x.firstAct, x.firstDate]), [['Nu Jazz', 'FreshAct', '2026-04-18']]);
});

test('genreMilestones tracks 10/25 marks, 10-year anniversaries, and nextUp within 5 sets', () => {
  const byArtist = genresByArtist([
    artist('HouseAct', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('RockAct', [{ parent: 'Rock', style: 'Indie Rock', weight: 1 }]),
    artist('OldOnly', [{ parent: 'Jazz', style: 'Bebop', weight: 1 }]),
  ]);

  const events: LoggedEvent[] = [
    ev('old-house', '2016-01-01', ['HouseAct']),
    ...Array.from({ length: 9 }, (_, i) => ev(`h-${i}`, `2026-01-0${i + 1}`, ['HouseAct'])), // total 10 House -> mark 10
    ...Array.from({ length: 5 }, (_, i) => ev(`r-${i}`, `2026-02-0${i + 1}`, ['RockAct'])), // total 5 Rock -> 5 away from 10 (nextUp)
    ev('old-jazz', '2015-01-01', ['OldOnly']), // 10+ years ago, but no set in last 12 months
  ];

  const ms = genreMilestones(events, byArtist, undefined, TODAY);
  assert.equal(ms.reached.length, 1);
  assert.equal(ms.reached[0].group, 'Electronic');
  assert.equal(ms.reached[0].mark, 10);
  assert.deepEqual(ms.anniversaries, [{ group: 'Electronic', years: 10 }]);
  assert.deepEqual(ms.nextUp, { group: 'Rock', mark: 10, remaining: 5 });

  // 4 sets -> 6 away from 10 -> nextUp is null
  const msTooFar = genreMilestones(events.filter((e) => e.id.startsWith('r-')).slice(0, 4), byArtist, undefined, TODAY);
  assert.equal(msTooFar.nextUp, null);
});

test('genreRange and genreLabel evaluate 30-set floor and every label in precedence order', () => {
  const byArtist = genresByArtist([
    artist('Tech', [{ parent: 'Electronic', style: 'Techno', weight: 1 }]),
    artist('House', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('Rock', [{ parent: 'Rock', style: 'Indie', weight: 1 }]),
    artist('Jazz', [{ parent: 'Jazz', style: 'Bebop', weight: 1 }]),
    artist('Folk', [{ parent: 'Folk', style: 'Indie Folk', weight: 1 }]),
    artist('Soul', [{ parent: 'Soul', style: 'Neo Soul', weight: 1 }]),
    artist('Pop', [{ parent: 'Pop', style: 'Synthpop', weight: 1 }]),
  ]);

  // Under 30 sets -> label is null
  const small = Array.from({ length: 29 }, (_, i) => ev(`s-${i}`, '2026-01-01', ['Tech']));
  assert.equal(genreLabel(small, byArtist, undefined, TODAY), null);

  const range = genreRange(small, byArtist, undefined, TODAY, ['Electronic', 'Rock', 'Jazz']);
  assert.equal(range.seenGroupCount, 1);
  assert.equal(range.totalGroupCount, 3);
  assert.deepEqual(range.missingGroups, ['Rock', 'Jazz']);

  // 1. Shape-shifter: all-time Electronic, last 12 months Rock (10+)
  const shapeShifter = [
    ...Array.from({ length: 20 }, (_, i) => ev(`ss-e-${i}`, '2024-01-01', ['Tech'])),
    ...Array.from({ length: 10 }, (_, i) => ev(`ss-r-${i}`, '2026-05-01', ['Rock'])),
  ];
  assert.equal(genreLabel(shapeShifter, byArtist, undefined, TODAY)?.label, 'Shape-shifter');

  // 2. Devoted: >= 60% in one group (all old so recent < 10)
  const devoted = [
    ...Array.from({ length: 20 }, (_, i) => ev(`d-e-${i}`, '2024-01-01', ['Tech'])),
    ...Array.from({ length: 10 }, (_, i) => ev(`d-r-${i}`, '2024-02-01', ['Rock'])),
  ];
  assert.equal(genreLabel(devoted, byArtist, undefined, TODAY)?.label, 'Devoted');

  // 3. Double act: top 2 >= 75%, each >= 25%
  const doubleAct = [
    ...Array.from({ length: 15 }, (_, i) => ev(`da-e-${i}`, '2024-01-01', ['Tech'])),
    ...Array.from({ length: 10 }, (_, i) => ev(`da-r-${i}`, '2024-02-01', ['Rock'])),
    ...Array.from({ length: 5 }, (_, i) => ev(`da-j-${i}`, '2024-03-01', ['Jazz'])),
  ];
  assert.equal(genreLabel(doubleAct, byArtist, undefined, TODAY)?.label, 'Double act');

  // 4. Deep diver: one style >= 25%, no group >= 60% and top2 < 75%
  const deepDiver = [
    ...Array.from({ length: 10 }, (_, i) => ev(`dd-e-${i}`, '2024-01-01', ['Tech'])), // Techno 10/36 = 27.8%
    ...Array.from({ length: 7 }, (_, i) => ev(`dd-h-${i}`, '2024-01-02', ['House'])), // Electronic 17/36 = 47%
    ...Array.from({ length: 7 }, (_, i) => ev(`dd-r-${i}`, '2024-02-01', ['Rock'])), // Rock 7/36 = 19% (top2 = 66.7%)
    ...Array.from({ length: 6 }, (_, i) => ev(`dd-j-${i}`, '2024-03-01', ['Jazz'])),
    ...Array.from({ length: 6 }, (_, i) => ev(`dd-f-${i}`, '2024-04-01', ['Folk'])),
  ];
  assert.equal(genreLabel(deepDiver, byArtist, undefined, TODAY)?.label, 'Deep diver');

  // 5. Explorer: 5+ groups, none over 40%, no single style >= 25%
  const explorer = [
    ...Array.from({ length: 6 }, (_, i) => ev(`ex-t-${i}`, '2024-01-01', ['Tech'])),
    ...Array.from({ length: 6 }, (_, i) => ev(`ex-h-${i}`, '2024-01-02', ['House'])), // Electronic 12/36 = 33%
    ...Array.from({ length: 6 }, (_, i) => ev(`ex-r-${i}`, '2024-02-01', ['Rock'])),
    ...Array.from({ length: 6 }, (_, i) => ev(`ex-j-${i}`, '2024-03-01', ['Jazz'])),
    ...Array.from({ length: 6 }, (_, i) => ev(`ex-f-${i}`, '2024-04-01', ['Folk'])),
    ...Array.from({ length: 6 }, (_, i) => ev(`ex-s-${i}`, '2024-05-01', ['Soul'])),
  ];
  assert.equal(genreLabel(explorer, byArtist, undefined, TODAY)?.label, 'Explorer');

  // 6. All-rounder: 3 groups (<5 groups), none >= 60%, top2 < 75%, no style >= 25%
  const allRounder = [
    ...Array.from({ length: 7 }, (_, i) => ev(`ar-t-${i}`, '2024-01-01', ['Tech'])),
    ...Array.from({ length: 7 }, (_, i) => ev(`ar-h-${i}`, '2024-01-02', ['House'])), // Electronic 14/36 = 38.9%
    ...Array.from({ length: 7 }, (_, i) => ev(`ar-r-${i}`, '2024-02-01', ['Rock'])),
    ...Array.from({ length: 7 }, (_, i) => ev(`ar-j-${i}`, '2024-03-01', ['Jazz'])),
    ...Array.from({ length: 8 }, (_, i) => ev(`ar-f-${i}`, '2024-04-01', ['Folk'])), // 4 groups? Wait: 4 groups -> Explorer needs 5!
  ];
  // Above has 4 groups (Electronic, Rock, Jazz, Folk) and max style is 8/36 = 22.2% < 25%, top2 = 22/36 = 61% < 75%
  assert.equal(genreLabel(allRounder, byArtist, undefined, TODAY)?.label, 'All-rounder');
});

test('genreByYear and genreStoryLine handle thin years and all story line branches', () => {
  const byArtist = genresByArtist([
    artist('House', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('Rock', [{ parent: 'Rock', style: 'Indie', weight: 1 }]),
    artist('Jazz', [{ parent: 'Jazz', style: 'Bebop', weight: 1 }]),
  ]);

  const makeYear = (y: number, act: string, n = 10) =>
    Array.from({ length: n }, (_, i) => ev(`${y}-${act}-${i}`, `${y}-05-0${(i % 9) + 1}`, [act]));

  // Only 2 counted years + 1 thin year -> story line is null
  const twoCounted = [...makeYear(2020, 'House', 10), ...makeYear(2021, 'House', 10), ...makeYear(2022, 'Rock', 5)];
  const by2 = genreByYear(twoCounted, byArtist, undefined, TODAY);
  assert.equal(by2.countedYears, 2);
  assert.equal(by2.years[2].thin, true);
  assert.equal(genreStoryLine(by2), null);

  // Same leader every year
  const sameLeader = [...makeYear(2020, 'House'), ...makeYear(2021, 'House'), ...makeYear(2022, 'House')];
  assert.equal(genreStoryLine(genreByYear(sameLeader, byArtist, undefined, TODAY)), 'Electronic has led every year since 2020.');

  // Moved and stayed for 2+ years
  const moved = [...makeYear(2020, 'House'), ...makeYear(2021, 'Rock'), ...makeYear(2022, 'Rock')];
  assert.equal(genreStoryLine(genreByYear(moved, byArtist, undefined, TODAY)), 'You moved from electronic to rock around 2021.');

  // Changes year to year
  const flip = [...makeYear(2020, 'House'), ...makeYear(2021, 'Rock'), ...makeYear(2022, 'Jazz')];
  assert.equal(genreStoryLine(genreByYear(flip, byArtist, undefined, TODAY)), 'Your top genre changes from year to year.');
});

test('genreByKind and genreBySeason respect 10-set thresholds and headlines', () => {
  const byArtist = genresByArtist([
    artist('House', [{ parent: 'Electronic', style: 'House', weight: 1 }]),
    artist('Rock', [{ parent: 'Rock', style: 'Indie', weight: 1 }]),
  ]);

  const events = [
    ...Array.from({ length: 10 }, (_, i) => ev(`fest-${i}`, `2026-07-0${(i % 9) + 1}`, ['House'], { kind: 'festival', format: 'Club night' })),
    ...Array.from({ length: 10 }, (_, i) => ev(`conc-${i}`, `2026-01-0${(i % 9) + 1}`, ['Rock'], { kind: 'concert' })),
    ...Array.from({ length: 5 }, (_, i) => ev(`spring-${i}`, `2026-04-0${i + 1}`, ['House'])), // under 10 for Mar-May
  ];

  const byKind = genreByKind(events, byArtist, undefined, TODAY);
  assert.equal(byKind.bars.length, 3); // Festival (10), Concert (10), Club night (10)
  assert.ok(byKind.headline?.includes('Electronic') || byKind.headline?.includes('electronic'));

  const bySeason = genreBySeason(events, byArtist, undefined, TODAY);
  const junAug = bySeason.tiles.find((t) => t.label === 'Jun–Aug')!;
  const marMay = bySeason.tiles.find((t) => t.label === 'Mar–May')!;
  assert.equal(junAug.enough, true);
  assert.equal(marMay.enough, false);
  assert.equal(marMay.topGroup, null);
  assert.ok(bySeason.headline?.includes('Jun–Aug') || bySeason.headline?.includes('Dec–Feb'));
});

test('yearGenres enforces 10-set floor, 3-favourite floor, and carries no people fields', () => {
  const byArtist = genresByArtist([
    artist('Mira Vale', [{ parent: 'Electronic', style: 'Techno', weight: 1 }]),
    artist('RockAct', [{ parent: 'Rock', style: 'Indie', weight: 1 }]),
  ]);

  const smallYear = Array.from({ length: 9 }, (_, i) => ev(`sy-${i}`, '2026-03-01', ['Mira Vale']));
  assert.equal(yearGenres(smallYear, 2026, byArtist, undefined, TODAY), null);

  const events = [
    ...Array.from({ length: 5 }, (_, i) => ev(`25-${i}`, '2025-03-01', ['RockAct'])),
    ...Array.from({ length: 10 }, (_, i) =>
      ev(`26-${i}`, '2026-04-18', ['Mira Vale'], {
        seen: [{ key: 'mira vale', name: 'Mira Vale', from: 'you', favourite: i < 2 }],
        companions: ['Sam'],
      }),
    ),
  ];

  // 2 favourites -> favourites is null
  const y2fav = yearGenres(events, 2026, byArtist, undefined, TODAY)!;
  assert.equal(y2fav.favourites, null);
  assert.equal('companions' in y2fav, false);
  assert.equal('people' in y2fav, false);

  // 3 favourites -> favourites shown
  events[7].seen[0].favourite = true;
  const y3fav = yearGenres(events, 2026, byArtist, undefined, TODAY)!;
  assert.deepEqual(y3fav.favourites, { total: 3, topStyle: 'Techno', topCount: 3 });
  assert.equal(y3fav.topStyle.name, 'Techno');
  assert.equal(y3fav.newestToYou?.name, 'Techno');
  assert.equal(y3fav.distinctStyles, 1);
  assert.equal(y3fav.prevDistinctStyles, 1);
  assert.equal(y3fav.biggestChange?.name, 'Techno');
});

test('peopleGenres enforces privacy (ignores unknown personIds and locked events) and 3-show/50% thresholds', () => {
  const byArtist = genresByArtist([
    artist('Dnb', [{ parent: 'Electronic', style: 'Drum & bass', weight: 1 }]),
  ]);

  const peopleMap = new Map([['p-sam', 'Sam']]);
  const events: LoggedEvent[] = [
    ...Array.from({ length: 3 }, (_, i) => ev(`sam-${i}`, `2026-01-0${i + 1}`, ['Dnb'], { personIds: ['p-sam', 'p-secret'] })),
    ev('locked', '2026-02-01', ['Dnb'], { personIds: ['p-sam'], peopleLocked: true }),
    ev('unknown-only', '2026-02-02', ['Dnb'], { personIds: ['p-unknown'] }),
  ];

  const res = peopleGenres(events, byArtist, undefined, peopleMap, TODAY);
  assert.equal(res.people.length, 1);
  assert.equal(res.people[0].name, 'Sam');
  assert.equal(res.people[0].shows, 3);
  assert.deepEqual(res.people[0].topGroups, [{ group: 'Electronic', count: 3, totalWithAnyone: 3 }]);
  assert.equal(res.headline, 'Electronic nights are with Sam.');
});

test('genreTree builds nested umbrella trees with lit and dimmed branches', () => {
  const vocab: GenreVocabulary = {
    genres: [
      { key: 'electronic', name: 'Electronic', aliases: [], umbrellas: [] },
      { key: 'house', name: 'House', parent: 'Electronic', aliases: [], umbrellas: ['electronic'] },
      { key: 'deephouse', name: 'Deep house', parent: 'Electronic', aliases: [], umbrellas: ['house'] },
      { key: 'afrohouse', name: 'Afro house', parent: 'Electronic', aliases: [], umbrellas: ['house'] },
    ],
  };
  const byArtist = genresByArtist([artist('DeepAct', [{ parent: 'Electronic', style: 'Deep house', weight: 1 }])], vocab);
  const events = [ev('1', '2026-03-01', ['DeepAct'])];

  assert.deepEqual(genreTree(undefined, events, byArtist, TODAY), []);

  const tree = genreTree(vocab, events, byArtist, TODAY);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'Electronic');
  assert.equal(tree[0].sets, 1);
  assert.equal(tree[0].seen, true);
  assert.equal(tree[0].seenBranches, 2); // House + Deep house
  assert.equal(tree[0].totalBranches, 3); // House + Deep house + Afro house
  const houseNode = tree[0].children[0];
  assert.equal(houseNode.name, 'House');
  assert.equal(houseNode.seen, true);
  assert.equal(houseNode.children.find((c) => c.key === 'afrohouse')?.seen, false);
});

test('taxonomy: groups roll up to macros, families sit between macro and genre, and the tree runs macro, family, genre', () => {
  const vocab: GenreVocabulary = {
    genres: [
      { key: 'macro:electronic', name: 'Electronic', level: 'macro', aliases: [], umbrellas: [] },
      { key: 'family:house', name: 'House', level: 'family', primaryParent: 'macro:electronic', aliases: [], umbrellas: [] },
      { key: 'deephouse', name: 'Deep house', primaryParent: 'family:house', aliases: [], umbrellas: [] },
      { key: 'techhouse', name: 'Tech house', primaryParent: 'family:house', aliases: [], umbrellas: [] },
      { key: 'ambient', name: 'Ambient', aliases: [], umbrellas: [] },
    ],
  };
  const byArtist = genresByArtist(
    [
      artist('A', [
        { parent: 'Dance', style: 'Deep house', weight: 0.6 },
        { parent: 'Dance', style: 'Tech house', weight: 0.4 },
      ]),
      artist('B', [{ parent: 'Ambient', style: 'Ambient', weight: 1 }]),
    ],
    vocab,
  );
  const events = [ev('1', '2026-03-01', ['A', 'B'])];

  const mix = genreMix(events, byArtist, vocab);
  assert.deepEqual(
    mix.parents.map((p) => [p.name, Math.round(p.sets * 1000) / 1000]),
    [
      ['Electronic', 1],
      ['Not grouped', 1],
    ],
  );
  assert.deepEqual(mix.families.map((p) => [p.name, Math.round(p.sets * 1000) / 1000]), [['House', 1]]);

  const roots = genreTree(vocab, events, byArtist, TODAY);
  assert.deepEqual(roots.map((r) => r.name), ['Electronic', 'Not grouped']);
  const house = roots[0].children[0];
  assert.equal(house.level, 'family');
  assert.equal(house.name, 'House');
  assert.deepEqual(house.children.map((c) => [c.name, c.level]), [
    ['Deep house', 'genre'],
    ['Tech house', 'genre'],
  ]);
  assert.equal(roots[0].seenBranches, 3);
  assert.equal(roots[0].totalBranches, 3);
  assert.equal(roots[1].children[0].name, 'Ambient');
});

test('legacy fallback: without a taxonomy the mix groups by the stored parent and has no families', () => {
  const byArtist = genresByArtist([artist('A', [{ parent: 'Electronic', style: 'Deep house', weight: 1 }])]);
  const mix = genreMix([ev('1', '2026-03-01', ['A'])], byArtist, undefined);
  assert.deepEqual(mix.parents.map((p) => p.name), ['Electronic']);
  assert.deepEqual(mix.families, []);
});

// Multi-zoom (docs/specs/genre-taxonomy-release-1.md decisions 1-6 and section 2).
const zoomVocab: GenreVocabulary = {
  genres: [
    { key: 'macro:electronic', name: 'Electronic', level: 'macro', aliases: [], umbrellas: [] },
    { key: 'family:house', name: 'House', level: 'family', primaryParent: 'macro:electronic', aliases: [], umbrellas: [] },
    { key: 'deephouse', name: 'Deep house', primaryParent: 'family:house', aliases: [], umbrellas: [] },
    { key: 'techhouse', name: 'Tech house', primaryParent: 'family:house', aliases: [], umbrellas: [] },
    { key: 'ambient', name: 'Ambient', aliases: [], umbrellas: [] },
  ],
};

const zoomRows = (): ArtistGenres[] => [
  artist('A', [
    { parent: 'Dance', style: 'Deep house', weight: 0.6 },
    { parent: 'Dance', style: 'Tech house', weight: 0.4 },
  ]),
  artist('B', [{ parent: 'Ambient', style: 'Ambient', weight: 1 }]),
];

const sumOf = (rows: Array<{ sets: number }>): number => rows.reduce((t, r) => t + r.sets, 0);

test('genreZoom: each level sums to known, and family and macro children sum to their parent', () => {
  const byArtist = genresByArtist(zoomRows(), zoomVocab);
  const events = [ev('1', '2026-03-01', ['A', 'B'])];
  const z = genreZoom(events, byArtist, zoomVocab);

  assert.equal(z.levels, 'taxonomy');
  assert.equal(z.known, 2);
  assert.equal(z.unknown, 0);
  for (const list of [z.macros, z.families, z.genres]) {
    assert.ok(Math.abs(sumOf(list) - z.known) < 1e-9);
    assert.ok(Math.abs(list.reduce((t, r) => t + r.share, 0) - 1) < 1e-9);
  }

  const electronic = z.macros.find((m) => m.name === 'Electronic')!;
  assert.equal(electronic.key, 'macro:electronic');
  assert.equal(electronic.sets, 1);
  assert.equal(electronic.share, 0.5);
  assert.equal(sumOf(electronic.children ?? []), electronic.sets);

  const house = z.families.find((f) => f.name === 'House')!;
  assert.equal(house.key, 'family:house');
  assert.equal(house.parentKey, 'macro:electronic');
  assert.ok(Math.abs(sumOf(house.children ?? []) - house.sets) < 1e-9);
  assert.deepEqual((house.children ?? []).map((g) => [g.name, g.parentKey]), [
    ['Deep house', 'family:house'],
    ['Tech house', 'family:house'],
  ]);
});

test('genreZoom: a genre with no family sits under Not grouped at both levels', () => {
  const byArtist = genresByArtist(zoomRows(), zoomVocab);
  const z = genreZoom([ev('1', '2026-03-01', ['B'])], byArtist, zoomVocab);

  const ambient = z.genres.find((g) => g.name === 'Ambient')!;
  assert.equal(ambient.parentKey, 'family:not-grouped');
  const notGroupedFamily = z.families.find((f) => f.name === 'Not grouped')!;
  assert.equal(notGroupedFamily.key, 'family:not-grouped');
  assert.equal(notGroupedFamily.parentKey, 'macro:not-grouped');
  assert.equal(z.macros.find((m) => m.name === 'Not grouped')!.sets, 1);
  assert.equal(z.macros.find((m) => m.name === 'Not grouped')!.key, 'macro:not-grouped');
});

test('genreZoom: sets of acts with no genre are unknown and not in known', () => {
  const byArtist = genresByArtist([...zoomRows(), artist('Empty', [])], zoomVocab);
  const z = genreZoom([ev('1', '2026-03-01', ['A', 'C', 'Empty'])], byArtist, zoomVocab);

  assert.equal(z.known, 1);
  assert.equal(z.unknown, 2);
  assert.equal(z.enough, false);
  assert.ok(Math.abs(sumOf(z.macros) - 1) < 1e-9);
});

test('genreZoom: a B2B set counts half for each act', () => {
  const byArtist = genresByArtist(zoomRows(), zoomVocab);
  const z = genreZoom([b2bEvent(ev('1', '2026-03-01', ['A', 'B']))], byArtist, zoomVocab);

  assert.equal(z.known, 1);
  assert.equal(z.macros.find((m) => m.name === 'Electronic')!.sets, 0.5);
  assert.equal(z.macros.find((m) => m.name === 'Not grouped')!.sets, 0.5);
  assert.equal(z.families.find((f) => f.name === 'House')!.sets, 0.5);
});

test('genreZoom: enough is false at 9.5 known sets and true at 10', () => {
  const byArtist = genresByArtist(zoomRows(), zoomVocab);
  const base = Array.from({ length: 9 }, (_, i) => ev(`solo-${i}`, '2026-01-01', ['A']));

  // 9 solo sets plus a B2B with an act that has no genre: 9.5 known.
  const short = genreZoom([...base, b2bEvent(ev('x', '2026-02-01', ['A', 'C']))], byArtist, zoomVocab);
  assert.equal(short.known, 9.5);
  assert.equal(short.unknown, 0.5);
  assert.equal(ZOOM_MIN_SETS, 10);
  assert.equal(short.enough, false);

  // 9 solo sets plus a B2B with a known act: 10 known.
  const full = genreZoom([...base, b2bEvent(ev('y', '2026-02-01', ['A', 'B']))], byArtist, zoomVocab);
  assert.equal(full.known, 10);
  assert.equal(full.enough, true);
});

test('genreZoom: without a taxonomy it falls back to music-story groups with no families or genres', () => {
  const byArtist = genresByArtist([artist('A', [{ parent: 'Electronic', style: 'Deep house', weight: 1 }])]);
  const z = genreZoom([ev('1', '2026-03-01', ['A'])], byArtist, undefined);

  assert.equal(z.levels, 'groups');
  assert.deepEqual(z.macros.map((m) => [m.name, m.sets, m.share]), [['Electronic', 1, 1]]);
  assert.deepEqual(z.families, []);
  assert.deepEqual(z.genres, []);
});

// Sound Drift (docs/specs/genre-taxonomy-release-1.md section 4).
let driftSeq = 0;
const setsIn = (year: number, names: string[], n = 1, extra: Partial<LoggedEvent> = {}): LoggedEvent[] =>
  Array.from({ length: n }, () => ev(`d${driftSeq++}`, `${year}-03-01`, names, extra));

const driftFamilies = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'Zulu'];
const driftVocab: GenreVocabulary = {
  genres: [
    { key: 'macro:electronic', name: 'Electronic', level: 'macro', aliases: [], umbrellas: [] },
    ...driftFamilies.map((f): VocabGenre => ({
      key: `family:${f.toLowerCase()}`, name: f, level: 'family', primaryParent: 'macro:electronic', aliases: [], umbrellas: [],
    })),
    ...driftFamilies.map((f): VocabGenre => ({
      key: `${f.toLowerCase()}style`, name: `${f} style`, primaryParent: `family:${f.toLowerCase()}`, aliases: [], umbrellas: [],
    })),
    { key: 'ambient', name: 'Ambient', aliases: [], umbrellas: [] }, // no family: Not grouped
  ],
};
const famAct = (name: string, f: string): ArtistGenres => artist(name, [{ parent: 'Dance', style: `${f} style`, weight: 1 }]);
const driftRows = (): ArtistGenres[] => [
  famAct('A1', 'Alpha'), famAct('B1', 'Bravo'), famAct('C1', 'Charlie'), famAct('D1', 'Delta'),
  famAct('E1', 'Echo'), famAct('F1', 'Foxtrot'), famAct('G1', 'Golf'), famAct('H1', 'Hotel'), famAct('Z1', 'Zulu'),
  artist('Amb', [{ parent: 'Dance', style: 'Ambient', weight: 1 }]),
];
const sumShares = (y: { shares: Record<string, number> }): number => Object.values(y.shares).reduce((t, v) => t + v, 0);

// Years 2020 (Alpha 12, Bravo..Foxtrot 1 each, Golf and Hotel as a B2B pair) and 2019 (Zulu, thin).
const bandEvents = (): LoggedEvent[] => [
  ...setsIn(2019, ['Z1'], 5),
  ...setsIn(2020, ['A1'], 12),
  ...['B1', 'C1', 'D1', 'E1', 'F1'].flatMap((n) => setsIn(2020, [n])),
  b2bEvent(ev('gh', '2020-07-01', ['G1', 'H1'])),
];

test('soundDrift: each year\'s shares add to 1 and only counted years rank bands', () => {
  const byArtist = genresByArtist(zoomRows(), zoomVocab);
  const d = soundDrift([...setsIn(2020, ['A', 'B'], 10), ...setsIn(2021, ['A'], 3)], byArtist, zoomVocab, 'family', TODAY);

  assert.equal(d.levels, 'taxonomy');
  assert.deepEqual(d.years.map((y) => y.year), [2020, 2021]);
  for (const y of d.years) assert.ok(Math.abs(sumShares(y) - 1) < 1e-9);
  assert.deepEqual(d.bands, ['House', 'Not grouped']);
  assert.equal(d.years[0].shares.House, 0.5);
  assert.equal(d.years[0].shares['Not grouped'], 0.5);
  assert.equal(d.years[1].counted, false);
  assert.equal(d.years[1].shares.House, 1);
});

test('soundDrift: a year with 9.5 known sets is not counted and 10 is', () => {
  const byArtist = genresByArtist(zoomRows(), zoomVocab);
  assert.equal(DRIFT_MIN_SETS, 10);
  const base = setsIn(2020, ['A'], 9);

  // 9 solo sets plus a B2B with an act that has no genre: 9.5 known.
  const short = soundDrift([...base, b2bEvent(ev('x', '2020-02-01', ['A', 'C']))], byArtist, zoomVocab, 'family', TODAY);
  assert.equal(short.years[0].known, 9.5);
  assert.equal(short.years[0].counted, false);
  assert.equal(short.countedYears, 0);

  const full = soundDrift([...base, b2bEvent(ev('y', '2020-02-01', ['A', 'B']))], byArtist, zoomVocab, 'family', TODAY);
  assert.equal(full.years[0].known, 10);
  assert.equal(full.years[0].counted, true);
  assert.equal(full.countedYears, 1);
});

test('soundDrift: enough is false with 2 counted years and true with 3', () => {
  const byArtist = genresByArtist(zoomRows(), zoomVocab);
  assert.equal(DRIFT_MIN_YEARS, 3);
  const two = soundDrift([...setsIn(2020, ['A'], 10), ...setsIn(2021, ['A'], 10)], byArtist, zoomVocab, 'family', TODAY);
  assert.equal(two.countedYears, 2);
  assert.equal(two.enough, false);

  const three = soundDrift([...setsIn(2020, ['A'], 10), ...setsIn(2021, ['A'], 10), ...setsIn(2022, ['A'], 10)], byArtist, zoomVocab, 'family', TODAY);
  assert.equal(three.countedYears, 3);
  assert.equal(three.enough, true);
});

test('soundDrift: bands are capped at 6 plus Other, ranked from counted years only', () => {
  const byArtist = genresByArtist(driftRows(), driftVocab);
  assert.equal(DRIFT_BANDS, 6);
  const d = soundDrift(bandEvents(), byArtist, driftVocab, 'family', TODAY);

  // Alpha first, then the ties by name; Golf and Hotel (the B2B pair) fall to Other.
  // Zulu is only in the thin 2019 year, so it is not ranked and its weight is Other.
  assert.deepEqual(d.bands, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Other']);
  assert.equal(d.years[0].year, 2019);
  assert.equal(d.years[0].counted, false);
  assert.equal(d.years[0].shares.Other, 1);
  assert.equal(d.years[1].year, 2020);
  assert.ok(Math.abs(d.years[1].shares.Other - 1 / 18) < 1e-9); // G1 and H1 halves of 18 known sets
  for (const y of d.years) assert.ok(Math.abs(sumShares(y) - 1) < 1e-9);
});

test('soundDrift: leaders merge consecutive repeats and skip Not grouped when a named band leads', () => {
  const byArtist = genresByArtist(driftRows(), driftVocab);
  const events = [
    ...setsIn(2020, ['A1'], 10),
    ...setsIn(2021, ['A1'], 10),
    ...setsIn(2022, ['B1'], 10),
    ...setsIn(2023, ['A1'], 10),
    ...setsIn(2024, ['Z1'], 10),
    ...setsIn(2025, ['Amb'], 10), // Not grouped
    ...setsIn(2025, ['A1'], 3), // Alpha leads 2025 once Not grouped is set aside
  ];
  const d = soundDrift(events, byArtist, driftVocab, 'family', TODAY);

  assert.deepEqual(d.leaders, [
    { band: 'Alpha', from: 2020, to: 2021 },
    { band: 'Bravo', from: 2022, to: 2022 },
    { band: 'Alpha', from: 2023, to: 2023 },
    { band: 'Zulu', from: 2024, to: 2024 },
    { band: 'Alpha', from: 2025, to: 2025 },
  ]);
});

test('soundDrift: a macro level with no family puts the genre under Not grouped', () => {
  const byArtist = genresByArtist(driftRows(), driftVocab);
  const d = soundDrift(setsIn(2025, ['Amb'], 10), byArtist, driftVocab, 'macro', TODAY);
  assert.deepEqual(d.bands, ['Not grouped']);
  assert.equal(d.years[0].shares['Not grouped'], 1);
  assert.deepEqual(d.leaders, [{ band: 'Not grouped', from: 2025, to: 2025 }]);
});

test('driftDrivers: lists the sets and artists for a band and for Other, with B2B halves', () => {
  const byArtist = genresByArtist(driftRows(), driftVocab);
  const events = bandEvents();

  const alpha = driftDrivers(events, byArtist, driftVocab, 'family', TODAY, 2020, 'Alpha');
  assert.equal(alpha.sets.length, 12);
  assert.ok(alpha.sets.every((s) => s.act === 'A1' && s.share === 1 && s.date === '2020-03-01'));
  assert.deepEqual(alpha.artists, [{ key: 'a1', name: 'A1', sets: 12 }]);

  const other = driftDrivers(events, byArtist, driftVocab, 'family', TODAY, 2020, 'Other');
  assert.deepEqual(other.sets, [
    { eventId: 'gh', eventName: 'Event gh', date: '2020-07-01', act: 'G1', share: 0.5 },
    { eventId: 'gh', eventName: 'Event gh', date: '2020-07-01', act: 'H1', share: 0.5 },
  ]);
  assert.deepEqual(other.artists, [
    { key: 'g1', name: 'G1', sets: 0.5 },
    { key: 'h1', name: 'H1', sets: 0.5 },
  ]);

  // 2019 is not 2020: Zulu's thin-year sets do not show in 2020 drivers.
  assert.equal(driftDrivers(events, byArtist, driftVocab, 'family', TODAY, 2020, 'Zulu').sets.length, 0);
});

test('soundDrift: planned and missed events are excluded, as in genreByYear', () => {
  const byArtist = genresByArtist(driftRows(), driftVocab);
  const events = [
    ...setsIn(2020, ['A1'], 10),
    ev('planned', '2026-12-10', ['A1'], { attendance: 'planned' }),
    ev('missed', '2020-04-01', ['A1'], { attendance: 'missed' }),
  ];
  const d = soundDrift(events, byArtist, driftVocab, 'family', TODAY);
  assert.deepEqual(d.years.map((y) => [y.year, y.known]), [[2020, 10]]);
  assert.equal(driftDrivers(events, byArtist, driftVocab, 'family', TODAY, 2020, 'Alpha').sets.length, 10);
});

test('soundDrift: without a taxonomy it falls back to music-story groups and ignores level', () => {
  const rows = [
    artist('A', [{ parent: 'Electronic', style: 'Deep house', weight: 1 }]),
    artist('B', [{ parent: 'Rock', style: 'Indie', weight: 1 }]),
  ];
  const byArtist = genresByArtist(rows);
  const events = [...setsIn(2020, ['A'], 10), ...setsIn(2021, ['B'], 10)];
  const fam = soundDrift(events, byArtist, undefined, 'family', TODAY);
  const mac = soundDrift(events, byArtist, undefined, 'macro', TODAY);

  assert.equal(fam.levels, 'groups');
  assert.deepEqual(fam.bands, ['Electronic', 'Rock']);
  assert.deepEqual(fam, mac);
  assert.deepEqual(fam.years.map((y) => y.shares), [{ Electronic: 1, Rock: 0 }, { Electronic: 0, Rock: 1 }]);
});

// Lineup DNA (docs/specs/genre-taxonomy-release-2.md section 2 and decisions 1, 2, 5).
const dnaFamilies = ['House', 'Techno', 'Trance', 'Garage', 'Dubstep', 'Jazz', 'Folk'];
const dnaVocab: GenreVocabulary = {
  genres: [
    { key: 'macro:electronic', name: 'Electronic', level: 'macro', aliases: [], umbrellas: [] },
    ...dnaFamilies.map((f) => ({
      key: `family:${f.toLowerCase()}`, name: f, level: 'family' as const, primaryParent: 'macro:electronic', aliases: [], umbrellas: [],
    })),
    ...dnaFamilies.map((f) => ({
      key: `${f.toLowerCase()}core`, name: `${f} core`, primaryParent: `family:${f.toLowerCase()}`, aliases: [], umbrellas: [],
    })),
  ],
};

const dnaAct = (key: string, extra: Partial<LineupGenresAct> = {}): LineupGenresAct => ({
  key, name: key.toUpperCase(), stages: [], days: [], ...extra,
});

// A row whose one genre sits in the given family of dnaVocab.
const dnaRow = (key: string, parts: Array<{ family: string; weight: number }>): ArtistGenres =>
  artist(key, parts.map((p) => ({ parent: 'Electronic', style: `${p.family} core`, weight: p.weight })));

const dnaSegShares = (bar: { segments: Array<{ name: string; share: number }> }): Record<string, number> =>
  Object.fromEntries(bar.segments.map((s) => [s.name, s.share]));

test('lineupDna: shares add up to 1 per bar and every bar', () => {
  const acts = [dnaAct('a', { stages: ['Main', 'Second'] }), dnaAct('b', { stages: ['Main'] }), dnaAct('c')];
  const byArtist = genresByArtist([
    dnaRow('a', [{ family: 'House', weight: 0.6 }, { family: 'Techno', weight: 0.4 }]),
    dnaRow('b', [{ family: 'Trance', weight: 1 }]),
    dnaRow('c', [{ family: 'Jazz', weight: 1 }]),
  ], dnaVocab);
  const res = lineupDna(acts, byArtist, dnaVocab);

  assert.equal(res.levels, 'taxonomy');
  for (const bar of res.bars) {
    const sum = bar.segments.reduce((t, s) => t + s.share, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${bar.id} sums to ${sum}`);
    for (const s of bar.segments) {
      const gsum = s.genres.reduce((t, g) => t + g.share, 0);
      assert.ok(gsum <= s.share + 1e-9, `${bar.id} ${s.name} genres exceed the family`);
    }
  }
});

test('lineupDna: a B2B pair shares one set (1/2 each) and the rest count 1.0', () => {
  const acts = [
    dnaAct('a', { slotId: 's1' }),
    dnaAct('b', { slotId: 's1' }),
    dnaAct('c'),
  ];
  const byArtist = genresByArtist([
    dnaRow('a', [{ family: 'House', weight: 1 }]),
    dnaRow('b', [{ family: 'Techno', weight: 1 }]),
    dnaRow('c', [{ family: 'House', weight: 1 }]),
  ], dnaVocab);
  const whole = lineupDna(acts, byArtist, dnaVocab).bars[0];

  assert.equal(whole.id, 'all');
  assert.equal(whole.total, 3);
  assert.equal(whole.tagged, 3);
  const shares = dnaSegShares(whole);
  assert.ok(Math.abs(shares.House - 0.75) < 1e-9); // a 0.5 + c 1.0 of 2.0
  assert.ok(Math.abs(shares.Techno - 0.25) < 1e-9); // b 0.5 of 2.0
  const house = whole.segments.find((s) => s.name === 'House')!;
  assert.deepEqual(house.acts, ['c', 'a']); // by contribution: c 1.0, a 0.5
});

test('lineupDna: an act on two stages counts on both stage bars and once on the whole bill', () => {
  const acts = [
    dnaAct('a', { stages: ['Main', 'Second'] }),
    dnaAct('b', { stages: ['Main'] }),
    dnaAct('c', { stages: ['Second'] }),
  ];
  const byArtist = genresByArtist([
    dnaRow('a', [{ family: 'House', weight: 1 }]),
    dnaRow('b', [{ family: 'Techno', weight: 1 }]),
    dnaRow('c', [{ family: 'Techno', weight: 1 }]),
  ], dnaVocab);
  const res = lineupDna(acts, byArtist, dnaVocab);

  assert.deepEqual(res.bars.map((b) => b.id), ['all', 'stage:Main', 'stage:Second']);
  const [whole, main, second] = res.bars;
  assert.equal(whole.total, 3);
  assert.ok(Math.abs(whole.segments.find((s) => s.name === 'House')!.share - 1 / 3) < 1e-9);
  assert.equal(main.total, 2);
  assert.equal(main.tagged, 2);
  assert.ok(Math.abs(dnaSegShares(main).House - 0.5) < 1e-9);
  assert.equal(second.total, 2);
  assert.ok(Math.abs(dnaSegShares(second).House - 0.5) < 1e-9);
});

test('lineupDna: no-stage bar appears only when a named stage exists', () => {
  const rows = [
    dnaRow('a', [{ family: 'House', weight: 1 }]),
    dnaRow('b', [{ family: 'Techno', weight: 1 }]),
  ];
  const byArtist = genresByArtist(rows, dnaVocab);

  // No stage anywhere: whole bill only.
  const none = lineupDna([dnaAct('a'), dnaAct('b')], byArtist, dnaVocab);
  assert.deepEqual(none.bars.map((b) => b.id), ['all']);

  // A named stage and an act without one: the no-stage bar shows last.
  const mixed = lineupDna([dnaAct('a', { stages: ['Main'] }), dnaAct('b')], byArtist, dnaVocab);
  assert.deepEqual(mixed.bars.map((b) => b.id), ['all', 'stage:Main', 'no-stage']);
  assert.equal(mixed.bars[2].name, 'No stage listed');
  assert.equal(mixed.bars[2].total, 1);

  // Every act on a stage: no no-stage bar.
  const full = lineupDna([dnaAct('a', { stages: ['Main'] }), dnaAct('b', { stages: ['Main'] })], byArtist, dnaVocab);
  assert.deepEqual(full.bars.map((b) => b.id), ['all', 'stage:Main']);
});

test('lineupDna: Other collects the tail, and a 5th family shows only at 10% or more', () => {
  // 14 acts: House 4, Techno 3, Garage 2, Trance 2, Dubstep 1, Jazz 1, Folk 1.
  const counts: Array<[string, number]> = [['House', 4], ['Techno', 3], ['Garage', 2], ['Trance', 2], ['Dubstep', 1], ['Jazz', 1], ['Folk', 1]];
  const acts: LineupGenresAct[] = [];
  const rows: ArtistGenres[] = [];
  for (const [fam, n] of counts) {
    for (let i = 0; i < n; i++) {
      const key = `${fam.toLowerCase()}${i}`;
      acts.push(dnaAct(key));
      rows.push(dnaRow(key, [{ family: fam, weight: 1 }]));
    }
  }
  const whole = lineupDna(acts, genresByArtist(rows, dnaVocab), dnaVocab).bars[0];

  // Fifth family Dubstep is 1/14 (under 10%): not shown; Dubstep, Jazz and Folk go to Other.
  assert.deepEqual(whole.segments.map((s) => s.key), ['family:house', 'family:techno', 'family:garage', 'family:trance', 'other']);
  const other = whole.segments[4];
  assert.equal(other.name, 'Other');
  assert.ok(Math.abs(other.share - 3 / 14) < 1e-9);
  assert.ok(Math.abs(whole.segments[0].share - 4 / 14) < 1e-9);
  assert.deepEqual(other.acts.slice().sort(), ['dubstep0', 'folk0', 'jazz0']);
});

test('lineupDna: a fifth family at 10% or more gets its own segment; the sixth onwards goes to Other', () => {
  // Seven acts, one per family: each 1/7 (about 14%), so the fifth shows and the sixth and seventh go to Other.
  const acts = dnaFamilies.map((f) => dnaAct(f.toLowerCase()));
  const rows = dnaFamilies.map((f) => dnaRow(f.toLowerCase(), [{ family: f, weight: 1 }]));
  const whole = lineupDna(acts, genresByArtist(rows, dnaVocab), dnaVocab).bars[0];

  assert.deepEqual(whole.segments.map((s) => s.name), ['Dubstep', 'Folk', 'Garage', 'House', 'Jazz', 'Other']);
  assert.ok(Math.abs(whole.segments[4].share - 1 / 7) < 1e-9);
  assert.ok(Math.abs(whole.segments[5].share - 2 / 7) < 1e-9);
});

test('lineupDna: coverage, lowCoverage and enough flags', () => {
  const acts = [dnaAct('a'), dnaAct('b'), dnaAct('c'), dnaAct('d'), dnaAct('e')];
  const rows = [
    dnaRow('a', [{ family: 'House', weight: 1 }]),
    dnaRow('b', [{ family: 'House', weight: 1 }]),
    dnaRow('c', [{ family: 'Techno', weight: 1 }]),
    dnaRow('d', []), // checked, no genres: untagged
  ];
  const byArtist = genresByArtist(rows, dnaVocab);

  // 3 tagged of 5 acts: coverage exactly 0.6 is not low; 3 is the floor.
  const three = lineupDna(acts, byArtist, dnaVocab).bars[0];
  assert.equal(three.tagged, 3);
  assert.equal(three.total, 5);
  assert.equal(three.coverage, 0.6);
  assert.equal(three.lowCoverage, false);
  assert.equal(three.enough, true);
  assert.equal(LINEUP_DNA_MIN_ACTS, 3);

  // 2 tagged of 5: low coverage and under the floor.
  const two = lineupDna(acts.slice(0, 2).concat(acts.slice(3)), byArtist, dnaVocab).bars[0];
  assert.equal(two.tagged, 2);
  assert.equal(two.total, 4);
  assert.equal(two.lowCoverage, true);
  assert.equal(two.enough, false);

  // An empty lineup: nothing tagged, coverage 0.
  const empty = lineupDna([], byArtist, dnaVocab).bars[0];
  assert.equal(empty.total, 0);
  assert.equal(empty.coverage, 0);
  assert.equal(empty.enough, false);
  assert.deepEqual(empty.segments, []);
});

test('lineupDna: without a taxonomy it uses the music-story groups', () => {
  const rows = [
    artist('A', [{ parent: 'Electronic', style: 'Deep house', weight: 0.5 }, { parent: 'Rock', style: 'Indie', weight: 0.5 }]),
    artist('B', [{ parent: 'Rock', style: 'Punk', weight: 1 }]),
  ];
  const byArtist = genresByArtist(rows);
  const res = lineupDna([dnaAct('a'), dnaAct('b')], byArtist, undefined);

  assert.equal(res.levels, 'groups');
  const whole = res.bars[0];
  assert.deepEqual(whole.segments.map((s) => [s.key, s.name]), [['group:rock', 'Rock'], ['group:electronic', 'Electronic']]);
  assert.ok(Math.abs(whole.segments[0].share - 0.75) < 1e-9); // Rock 0.5 + 1.0 of 1.5 tagged
  assert.ok(Math.abs(whole.segments[1].share - 0.25) < 1e-9);
  assert.ok(Math.abs(whole.segments.reduce((t, s) => t + s.share, 0) - 1) < 1e-9);
});

// Event Match (docs/specs/genre-taxonomy-release-2.md section 4). Each genre sits in its own
// family ("Fam <name>") under one macro, so a family and a genre are the same thing here.
const emVocab = (names: string[], links: Array<[string, string, number]> = []): GenreVocabulary => {
  const genres: VocabGenre[] = [{ key: 'macro:electronic', name: 'Electronic', level: 'macro', aliases: [], umbrellas: [] }];
  for (const n of names) {
    genres.push({ key: `family:${genreKey(`Fam ${n}`)}`, name: `Fam ${n}`, level: 'family', primaryParent: 'macro:electronic', aliases: [], umbrellas: [] });
  }
  for (const n of names) {
    const relations = links
      .filter(([s]) => s === n)
      .map(([, t, w]) => ({ target: genreKey(t), type: 'adjacent' as const, weight: w, origin: 'curated' as const }));
    genres.push({
      key: genreKey(n), name: n, primaryParent: `family:${genreKey(`Fam ${n}`)}`, aliases: [], umbrellas: [],
      ...(relations.length ? { relations } : {}),
    });
  }
  return { genres };
};

const emRow = (key: string, styles: Array<[string, number]>): ArtistGenres =>
  artist(key, styles.map(([style, weight]) => ({ parent: 'Electronic', style, weight })));

// Past events, one per size: each has that many acts, all with one genre.
function emHistory(prefix: string, sizes: number[], style: string): { events: LoggedEvent[]; rows: ArtistGenres[] } {
  const events: LoggedEvent[] = [];
  const rows: ArtistGenres[] = [];
  sizes.forEach((n, i) => {
    const names = Array.from({ length: n }, (_, j) => `${prefix}${i}x${j}`);
    events.push(ev(`${prefix}-${i}`, '2025-06-01', names));
    for (const name of names) rows.push(emRow(name.toLowerCase(), [[style, 1]]));
  });
  return { events, rows };
}

test('eventMatch: one smoothing step reaches B from A on the chain A-B-C, but not C', () => {
  const chain = emVocab(['Alpha', 'Beta', 'Gamma'], [['Alpha', 'Beta', 1], ['Beta', 'Gamma', 1]]);
  const hist = emHistory('c', [1], 'Alpha');
  const byArtist = genresByArtist([...hist.rows, emRow('bl1', [['Beta', 1]]), emRow('bl2', [['Gamma', 1]])], chain);

  const toB = eventMatch('bill', hist.events, byArtist, [dnaAct('bl1')], chain);
  const toC = eventMatch('bill', hist.events, byArtist, [dnaAct('bl2')], chain);

  // Your vector: Alpha 1. Beta gets alpha * (1 / sqrt(deg Beta * deg Alpha)) = alpha / sqrt(2). Gamma gets 0.
  const expected = (MATCH_ALPHA / Math.SQRT2) / Math.sqrt(1 + (MATCH_ALPHA * MATCH_ALPHA) / 2);
  assert.ok(Math.abs(toB.score - expected) < 1e-9, `score ${toB.score}`);
  assert.ok(toB.score > 0);
  assert.equal(toC.score, 0);
  assert.equal(toC.band, 'outside');
});

test('eventMatch: hub dampening gives a genre linked to many less than one with a single link of the same weight', () => {
  const hub = emVocab(
    ['Alpha', 'H', 'G', 'X1', 'X2', 'X3', 'X4'],
    [['Alpha', 'H', 1], ['Alpha', 'G', 1], ['H', 'X1', 1], ['H', 'X2', 1], ['H', 'X3', 1], ['H', 'X4', 1]],
  );
  const hist = emHistory('h', [1], 'Alpha');
  const byArtist = genresByArtist([...hist.rows, emRow('bh', [['H', 1]]), emRow('bg', [['G', 1]])], hub);

  const toH = eventMatch('bill', hist.events, byArtist, [dnaAct('bh')], hub).score;
  const toG = eventMatch('bill', hist.events, byArtist, [dnaAct('bg')], hub).score;
  assert.ok(toH > 0);
  assert.ok(toG > toH, `G ${toG} should beat H ${toH}`);
});

test('eventMatch: the event itself is left out of your vector', () => {
  const vocab = emVocab(['Alpha', 'Beta']);
  const other = emHistory('o', [5], 'Beta');
  const focal = ev('bill', '2026-11-20', ['fa', 'fb', 'fc', 'fd', 'fe']);
  const focalRows = ['fa', 'fb', 'fc', 'fd', 'fe'].map((k) => emRow(k, [['Alpha', 1]]));
  const byArtist = genresByArtist([...other.rows, ...focalRows, emRow('ba', [['Alpha', 1]])], vocab);

  const res = eventMatch('bill', [...other.events, focal], byArtist, [dnaAct('ba')], vocab);
  assert.equal(res.sets, 5); // the 5 Beta sets; the focal event's 5 Alpha sets are not counted
  assert.equal(res.events, 1);
  assert.equal(res.band, 'outside'); // Alpha is not in your vector
});

test('eventMatch: strong band with an exact match, some band between 0.3 and 0.6, outside below 0.3', () => {
  const vocab = emVocab(['Alpha', 'Beta', 'Gamma']);
  const hist = emHistory('b', [2], 'Alpha');

  const strongRows = [...hist.rows, emRow('bs1', [['Alpha', 1]])];
  const strong = eventMatch('bill', hist.events, genresByArtist(strongRows, vocab), [dnaAct('bs1')], vocab);
  assert.ok(Math.abs(strong.score - 1) < 1e-9);
  assert.equal(strong.band, 'strong');

  // Bill: Alpha 1 and Beta 2 (one act, split 1/3 and 2/3). Cosine with Alpha alone is 1 / sqrt(5), about 0.447.
  const someRows = [...hist.rows, emRow('bx', [['Alpha', 1], ['Beta', 2]])];
  const some = eventMatch('bill', hist.events, genresByArtist(someRows, vocab), [dnaAct('bx')], vocab);
  assert.ok(Math.abs(some.score - 1 / Math.sqrt(5)) < 1e-9, `score ${some.score}`);
  assert.equal(some.band, 'some');

  const outsideRows = [...hist.rows, emRow('bo', [['Gamma', 1]])];
  const outside = eventMatch('bill', hist.events, genresByArtist(outsideRows, vocab), [dnaAct('bo')], vocab);
  assert.equal(outside.score, 0);
  assert.equal(outside.band, 'outside');
  assert.deepEqual(outside.lane, []);
});

test('eventMatch: lane is the two families that add most to the score', () => {
  const vocab = emVocab(['Alpha', 'Beta', 'Gamma']);
  const a = emHistory('la', [3], 'Alpha');
  const b = emHistory('lb', [2], 'Beta');
  const c = emHistory('lc', [1], 'Gamma');
  const rows = [...a.rows, ...b.rows, ...c.rows, emRow('l1', [['Alpha', 1]]), emRow('l2', [['Beta', 1]]), emRow('l3', [['Gamma', 1]])];
  const res = eventMatch('bill', [...a.events, ...b.events, ...c.events], genresByArtist(rows, vocab),
    [dnaAct('l1'), dnaAct('l2'), dnaAct('l3')], vocab);

  // Your vector 3 : 2 : 1 against an even bill. Dot contributions 3, 2, 1: Alpha and Beta.
  assert.deepEqual(res.lane, [{ key: 'family:famalpha', name: 'Fam Alpha' }, { key: 'family:fambeta', name: 'Fam Beta' }]);
  assert.equal(res.band, 'strong');
});

test('eventMatch: inLane, nearby and nearbyUnseen follow the top genre of each bill act', () => {
  const vocab = emVocab(['Alpha', 'Beta', 'Gamma'], [['Alpha', 'Beta', 1]]);
  const hist = emHistory('n', [1], 'Alpha');
  const focal = ev('bill', '2026-11-20', ['p3']); // p3 is seen at this event, so it is not unseen
  const rows = [
    ...hist.rows,
    emRow('p1', [['Alpha', 1]]), // top Alpha: yours
    emRow('p2', [['Beta', 1]]), // top Beta: adjacent to Alpha, never seen
    emRow('p3', [['Beta', 1]]), // top Beta: adjacent, seen at this event
    emRow('p4', [['Gamma', 1]]), // not adjacent to anything of yours
  ];
  const acts = ['p1', 'p2', 'p3', 'p4'].map((k) => dnaAct(k));
  const res = eventMatch('bill', [...hist.events, focal], genresByArtist(rows, vocab), acts, vocab);

  assert.deepEqual(res.inLane, ['p1']);
  assert.deepEqual(res.nearby, ['p2', 'p3']);
  assert.deepEqual(res.nearbyUnseen, ['p2']);
});

test('eventMatch: floors are 20 sets over 5 events, and Lineup DNA enough', () => {
  const vocab = emVocab(['Alpha']);
  const billRows = ['bl1', 'bl2', 'bl3'].map((k) => emRow(k, [['Alpha', 1]]));
  const bill = ['bl1', 'bl2', 'bl3'].map((k) => dnaAct(k));
  const run = (sizes: number[], prefix: string) => {
    const hist = emHistory(prefix, sizes, 'Alpha');
    return eventMatch('bill', hist.events, genresByArtist([...hist.rows, ...billRows], vocab), bill, vocab);
  };

  const nineteen = run([4, 4, 4, 4, 3], 'p'); // 19 sets over 5 events
  assert.equal(nineteen.sets, 19);
  assert.equal(nineteen.events, 5);
  assert.equal(nineteen.enough, false);

  const fourEvents = run([5, 5, 5, 5], 'q'); // 20 sets over only 4 events
  assert.equal(fourEvents.sets, MATCH_MIN_SETS);
  assert.equal(fourEvents.events, 4);
  assert.equal(fourEvents.enough, false);

  const passes = run([4, 4, 4, 4, 4], 'r'); // 20 sets over 5 events
  assert.equal(passes.sets, MATCH_MIN_SETS);
  assert.equal(passes.events, MATCH_MIN_EVENTS);
  assert.equal(passes.enough, true);
});
