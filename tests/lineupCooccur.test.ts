import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billsFrom,
  lineupCooccur,
  npmi,
  type CooccurPerformance,
} from '../src/server/events/lineupCooccur.ts';

const perf = (
  editionId: string,
  artistKey: string,
  stages: string[] = [],
  status?: string,
): CooccurPerformance => ({ editionId, artistKey, stages, status });

// Genre lookup for the act keys used in the fixtures below.
const genreMap = (map: Record<string, string[]>) => (artist: string) => map[artist] ?? [];

test('npmi: hand fixture gives PMI ln 2 normalised by -ln 0.4', () => {
  // n_gh = 4, n_g = 5, n_h = 4, N = 10: PMI = ln(40/20) = ln 2
  const expected = Math.log(2) / -Math.log(0.4);
  assert.ok(Math.abs(npmi(4, 5, 4, 10) - expected) < 1e-12);
  assert.ok(Math.abs(npmi(4, 5, 4, 10) - 0.756471) < 1e-5);
});

test('npmi: a pair on every bill is exactly 1', () => {
  assert.equal(npmi(3, 3, 3, 3), 1);
});

test('lineupCooccur: PMI and NPMI on a hand fixture', () => {
  // A on 5 bills, B on 4, A and B together on 4, C on 5. N = 10.
  const bills = [
    ...Array.from({ length: 4 }, () => ['a1', 'b1']),
    ['a2'],
    ...Array.from({ length: 5 }, () => ['c1']),
  ];
  const result = lineupCooccur(
    bills,
    genreMap({ a1: ['A'], b1: ['B'], a2: ['A'], c1: ['C'] }),
  );
  assert.deepEqual(result.links, [{ source: 'A', target: 'B', weight: 0.756, bills: 4 }]);
  assert.equal(result.billsUsed, 10);
  assert.deepEqual(result.genres, [
    { genre: 'A', bills: 5 },
    { genre: 'B', bills: 4 },
    { genre: 'C', bills: 5 },
  ]);
});

test('lineupCooccur: support floor drops a pair on 2 bills even with NPMI 1', () => {
  // A and B on 2 bills; N = 10. NPMI is exactly 1 but support is below 3.
  const bills = [
    ['a1', 'b1'],
    ['a1', 'b1'],
    ...Array.from({ length: 8 }, () => ['c1']),
  ];
  const genres = genreMap({ a1: ['A'], b1: ['B'], c1: ['C'] });
  assert.deepEqual(lineupCooccur(bills, genres).links, []);
  assert.deepEqual(lineupCooccur(bills, genres, { minBills: 2 }).links, [
    { source: 'A', target: 'B', weight: 1, bills: 2 },
  ]);
});

test('lineupCooccur: NPMI floor drops a weak pair', () => {
  // A on 6 bills, B on 6, together on 4, N = 10: NPMI is about 0.115, below 0.2.
  const bills = [
    ...Array.from({ length: 4 }, () => ['a1', 'b1']),
    ['a2'],
    ['a2'],
    ['b2'],
    ['b2'],
    ['c1'],
    ['c1'],
  ];
  const genres = genreMap({ a1: ['A'], a2: ['A'], b1: ['B'], b2: ['B'], c1: ['C'] });
  assert.deepEqual(lineupCooccur(bills, genres).links, []);
  assert.equal(lineupCooccur(bills, genres, { minNpmi: 0.1 }).links.length, 1);
});

test('lineupCooccur: per-genre cap keeps only the first perGenre links of a hub', () => {
  // H sits with five partners X1..X5, 3 bills each. 20 filler bills with Z give N = 35.
  // Every H pair has the same weight, so the order falls to source then target.
  const bills: string[][] = [];
  for (let i = 1; i <= 5; i++) {
    for (let k = 0; k < 3; k++) bills.push(['h', `x${i}`]);
  }
  for (let k = 0; k < 20; k++) bills.push(['z']);
  const genres = genreMap({
    h: ['H'],
    x1: ['X1'],
    x2: ['X2'],
    x3: ['X3'],
    x4: ['X4'],
    x5: ['X5'],
    z: ['Z'],
  });

  const capped = lineupCooccur(bills, genres, { perGenre: 2 });
  assert.deepEqual(
    capped.links.map((l) => [l.source, l.target]),
    [
      ['H', 'X1'],
      ['H', 'X2'],
    ],
  );
  assert.ok(capped.links.every((l) => l.weight === 0.345 && l.bills === 3));

  const uncapped = lineupCooccur(bills, genres);
  assert.equal(uncapped.links.length, 5);
});

test('lineupCooccur: curated pairs are skipped in either order', () => {
  const bills = [
    ...Array.from({ length: 4 }, () => ['a1', 'b1']),
    ['a2'],
    ...Array.from({ length: 5 }, () => ['c1']),
  ];
  const genres = genreMap({ a1: ['A'], b1: ['B'], a2: ['A'], c1: ['C'] });
  assert.equal(lineupCooccur(bills, genres).links.length, 1);
  assert.deepEqual(lineupCooccur(bills, genres, { curated: new Set(['A|B']) }).links, []);
  assert.deepEqual(lineupCooccur(bills, genres, { curated: new Set(['B|A']) }).links, []);
  assert.equal(
    lineupCooccur(bills, genres, { curated: new Set(['A|C']) }).links.length,
    1,
  );
});

test('lineupCooccur: a genre repeated across two acts on one bill counts once', () => {
  // Bill one is a B2B pair: x has A and B, y has A. Both count A once per bill.
  const bills = [['x1', 'y1'], ['x1', 'y1'], ['x1', 'y1'], ['z1']];
  const result = lineupCooccur(
    bills,
    genreMap({ x1: ['A', 'B'], y1: ['A'], z1: ['C'] }),
  );
  assert.equal(result.billsUsed, 4);
  assert.deepEqual(result.genres, [
    { genre: 'A', bills: 3 },
    { genre: 'B', bills: 3 },
    { genre: 'C', bills: 1 },
  ]);
  assert.deepEqual(result.links, [{ source: 'A', target: 'B', weight: 1, bills: 3 }]);
});

test('lineupCooccur: only the first topGenres genres of an act count', () => {
  const result = lineupCooccur([['p1']], genreMap({ p1: ['A', 'B', 'C', 'D'] }));
  assert.deepEqual(
    result.genres.map((g) => g.genre),
    ['A', 'B', 'C'],
  );
});

test('lineupCooccur: bills with no genre are left out of N', () => {
  const result = lineupCooccur([['u1'], ['a1']], genreMap({ a1: ['A'] }));
  assert.equal(result.billsUsed, 1);
  assert.deepEqual(result.links, []);
});

test('lineupCooccur: same input gives the same output whatever the bill order', () => {
  const bills: string[][] = [
    ...Array.from({ length: 4 }, () => ['a1', 'b1']),
    ['a2'],
    ...Array.from({ length: 5 }, () => ['c1']),
    ...Array.from({ length: 3 }, () => ['h', 'x1']),
    ...Array.from({ length: 20 }, () => ['z']),
  ];
  const genres = genreMap({
    a1: ['A'],
    b1: ['B'],
    a2: ['A'],
    c1: ['C'],
    h: ['H'],
    x1: ['X'],
    z: ['Z'],
  });
  const first = lineupCooccur(bills, genres);
  const second = lineupCooccur(bills, genres);
  const reversed = lineupCooccur([...bills].reverse(), genres);
  assert.deepEqual(second, first);
  assert.deepEqual(reversed, first);
});

test('billsFrom: stages make one bill each, and cancelled rows are skipped', () => {
  const perfs: CooccurPerformance[] = [
    // ed1 has stages: one bill per stage
    perf('ed1', 'a', ['Main']),
    perf('ed1', 'b', ['Main']),
    perf('ed1', 'c', ['Tent']),
    // ed2 has no stages: one bill of all its acts; a cancelled act is skipped
    perf('ed2', 'd'),
    perf('ed2', 'e', []),
    perf('ed2', 'f'),
    perf('ed2', 'g', [], 'cancelled'),
    // ed3: a lone no-stage act is dropped; the staged act is one bill
    perf('ed3', 'h', ['Main']),
    perf('ed3', 'i'),
    perf('ed3', 'j'),
    // ed4: one staged act and one lone no-stage act
    perf('ed4', 'k', ['Main']),
    perf('ed4', 'l'),
    // ed5: an act on two stages sits in both bills
    perf('ed5', 'm', ['Main', 'Late']),
    perf('ed5', 'n', ['Late']),
    // ed6: a repeated act on the same stage is deduped
    perf('ed6', 'p', ['Main']),
    perf('ed6', 'p', ['Main']),
    // ed7: only cancelled rows, so no bill
    perf('ed7', 'q', ['Main'], 'cancelled'),
  ];
  assert.deepEqual(billsFrom(perfs), [
    ['a', 'b'],
    ['c'],
    ['d', 'e', 'f'],
    ['h'],
    ['i', 'j'],
    ['k'],
    ['m', 'n'],
    ['m'],
    ['p'],
  ]);
});

test('billsFrom: the result does not depend on the row order', () => {
  const perfs: CooccurPerformance[] = [
    perf('ed1', 'a', ['Main']),
    perf('ed1', 'b', ['Tent']),
    perf('ed2', 'c'),
    perf('ed2', 'd'),
  ];
  assert.deepEqual(billsFrom([...perfs].reverse()), billsFrom(perfs));
});
