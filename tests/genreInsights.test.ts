import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoggedEvent } from '../src/server/events/types.ts';
import type { ArtistGenres, GenreVocabulary } from '../src/server/events/genreTypes.ts';
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
