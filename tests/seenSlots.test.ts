import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoggedEvent, SeenAct } from '../src/server/events/types.ts';
import {
  b2bGroups,
  leaveB2b,
  lineupSlots,
  pairB2b,
  seenSlots,
  slotLabel,
  toSeenInput,
  withB2b,
} from '../src/server/events/seen.ts';
import { top } from '../src/services/stats.ts';
import { artistSummaries } from '../src/services/artists.ts';

const act = (name: string, patch: Partial<SeenAct> = {}): SeenAct => ({
  key: name.toLowerCase(),
  name,
  from: 'you',
  ...patch,
});

const ev = (id: string, patch: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

test('an artist with both a solo set and a B2B set renders 2 distinct slots without key collision', () => {
  // Case 1: Solo set first, then B2B set
  const seen1: SeenAct[] = [
    act('John Summit', { id: 'js-solo' }),
    act('John Summit', { id: 'js-b2b', b2b: ['dom dolla'] }),
    act('Dom Dolla', { id: 'dd-b2b', b2b: ['john summit'] }),
  ];

  const slots1 = seenSlots(seen1);
  assert.equal(slots1.length, 2);
  assert.deepEqual(slots1.map(slotLabel), ['John Summit', 'John Summit b2b Dom Dolla']);
  assert.equal(slots1[0][0].id, 'js-solo');
  assert.equal(slots1[1][0].id, 'js-b2b');
  assert.equal(slots1[1][1].id, 'dd-b2b');

  // Case 2: B2B set first, then solo set
  const seen2: SeenAct[] = [
    act('John Summit', { id: 'js-b2b', b2b: ['dom dolla'] }),
    act('Dom Dolla', { id: 'dd-b2b', b2b: ['john summit'] }),
    act('John Summit', { id: 'js-solo' }),
  ];

  const slots2 = seenSlots(seen2);
  assert.equal(slots2.length, 2);
  assert.deepEqual(slots2.map(slotLabel), ['John Summit b2b Dom Dolla', 'John Summit']);
  assert.equal(slots2[0][0].id, 'js-b2b');
  assert.equal(slots2[0][1].id, 'dd-b2b');
  assert.equal(slots2[1][0].id, 'js-solo');

  // withB2b should preserve solo status without clobbering
  const normalized = withB2b(seen1);
  assert.equal(normalized[0].b2b, undefined);
  assert.deepEqual(normalized[1].b2b, ['dom dolla']);
  assert.deepEqual(normalized[2].b2b, ['john summit']);
});

test('legacy acts with solo: true still unpack properly', () => {
  const seen: SeenAct[] = [
    act('Sasha', { set: 'dj', b2b: ['john digweed'], solo: true, soloSet: 'live' }),
    act('John Digweed', { set: 'dj', b2b: ['sasha'] }),
    act('Bicep'),
  ];

  const slots = seenSlots(seen);
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map(slotLabel), [
    'Sasha b2b John Digweed (DJ Set)',
    'Sasha (solo, Live)',
    'Bicep',
  ]);
});

test('slotLabel formats custom set strings cleanly in parentheses', () => {
  const seen: SeenAct[] = [
    act('Porter Robinson', { set: 'DJ Set' }),
    act('Tiësto', { set: 'Sunrise Set' }),
    act('Slander', { set: 'Gud Vibrations', b2b: ['nghtmre'] }),
    act('NGHTMRE', { set: 'Gud Vibrations', b2b: ['slander'] }),
    act('Eric Prydz', { set: 'HOLO' }),
  ];

  const slots = seenSlots(seen);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map(slotLabel), [
    'Porter Robinson (DJ Set)',
    'Tiësto (Sunrise Set)',
    'Slander b2b NGHTMRE (Gud Vibrations)',
    'Eric Prydz (HOLO)',
  ]);
});

test('lineupSlots groups B2B performances sharing reciprocal b2b into unified slots', () => {
  interface Perf {
    artistKey: string;
    name: string;
    b2b?: string[];
    slotId?: string;
    stage: string;
    day: string;
  }

  const perfs: Perf[] = [
    { artistKey: 'a-trak', name: 'A-Trak', b2b: ['craze'], stage: 'cosmicMeadow', day: '2022-05-22' },
    { artistKey: 'craze', name: 'Craze', b2b: ['a-trak'], stage: 'cosmicMeadow', day: '2022-05-22' },
    { artistKey: 'kaskade', name: 'Kaskade', stage: 'kineticField', day: '2022-05-21' },
    { artistKey: 'a-trak', name: 'A-Trak', stage: 'bassPOD', day: '2022-05-20' }, // Solo set
  ];

  const slots = lineupSlots(perfs);
  assert.equal(slots.length, 3);
  // Slot 1: B2B pairing
  assert.equal(slots[0].length, 2);
  assert.equal(slots[0][0].name, 'A-Trak');
  assert.equal(slots[0][1].name, 'Craze');
  // Slot 2: Kaskade solo
  assert.equal(slots[1].length, 1);
  assert.equal(slots[1][0].name, 'Kaskade');
  // Slot 3: A-Trak solo
  assert.equal(slots[2].length, 1);
  assert.equal(slots[2][0].name, 'A-Trak');
  assert.equal(slots[2][0].stage, 'bassPOD');
});

test('lineupSlots groups performances sharing slotId', () => {
  const perfs = [
    { artistKey: 'artist1', name: 'Artist 1', slotId: 'slot-xyz' },
    { artistKey: 'artist2', name: 'Artist 2', slotId: 'slot-xyz' },
    { artistKey: 'artist3', name: 'Artist 3' },
  ];

  const slots = lineupSlots(perfs);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].length, 2);
  assert.deepEqual(slots[0].map((p) => p.name), ['Artist 1', 'Artist 2']);
  assert.equal(slots[1].length, 1);
  assert.equal(slots[1][0].name, 'Artist 3');
});

test('top() in stats.ts counts 2 viewings for an artist seen twice on one event', () => {
  const event = ev('edc-2024', {
    startDate: '2024-05-17',
    seen: [
      act('John Summit', { id: 'js-solo' }),
      act('John Summit', { id: 'js-b2b', b2b: ['dom dolla'] }),
      act('Dom Dolla', { id: 'dd-b2b', b2b: ['john summit'] }),
    ],
  });

  const ranked = top([event], 'artist');
  assert.equal(ranked.length, 2);

  const js = ranked.find((r) => r.key === 'john summit');
  assert.ok(js);
  assert.equal(js.count, 2); // 2 sets/viewings

  const dd = ranked.find((r) => r.key === 'dom dolla');
  assert.ok(dd);
  assert.equal(dd.count, 1); // 1 set/viewing

  // Unique artists count is still 2
  const uniqueArtists = new Set([event].flatMap((e) => e.seen.map((s) => s.key))).size;
  assert.equal(uniqueArtists, 2);
});

test('artistSummaries tracks sets linearly and deduplicates events', () => {
  const event1 = ev('edc-2024', {
    startDate: '2024-05-17',
    seen: [
      act('John Summit', { id: 'js-solo' }),
      act('John Summit', { id: 'js-b2b', b2b: ['dom dolla'] }),
      act('Dom Dolla', { id: 'dd-b2b', b2b: ['john summit'] }),
    ],
  });
  const event2 = ev('coachella-2024', {
    startDate: '2024-04-12',
    seen: [act('John Summit', { role: 'headliner' })],
  });

  const summaries = artistSummaries([event1, event2]);
  const js = summaries.find((a) => a.key === 'john summit')!;
  assert.ok(js);
  assert.equal(js.events.length, 2); // EDC and Coachella
  assert.equal(js.sets, 3); // 2 sets at EDC + 1 set at Coachella
  assert.equal(js.headlined, 1);

  const dd = summaries.find((a) => a.key === 'dom dolla')!;
  assert.ok(dd);
  assert.equal(dd.events.length, 1);
  assert.equal(dd.sets, 1);
});

test('toSeenInput preserves id and slotId', () => {
  const seen: SeenAct[] = [
    act('John Summit', { id: 'js-1', slotId: 'slot-1', favourite: true, set: 'dj' }),
    act('Dom Dolla', { id: 'dd-1', slotId: 'slot-1', b2b: ['john summit'] }),
  ];

  const patch = toSeenInput(seen);
  assert.equal(patch[0].id, 'js-1');
  assert.equal(patch[0].slotId, 'slot-1');
  assert.equal(patch[0].favourite, true);
  assert.equal(patch[0].set, 'dj');

  assert.equal(patch[1].id, 'dd-1');
  assert.equal(patch[1].slotId, 'slot-1');
  assert.deepEqual(patch[1].b2b, ['john summit']);
});

test('pairB2b and leaveB2b support instance IDs', () => {
  const seen: SeenAct[] = [
    act('John Summit', { id: 'js-solo' }),
    act('John Summit', { id: 'js-b2b' }),
    act('Dom Dolla', { id: 'dd' }),
  ];

  // Pair specific instance js-b2b with dd
  const paired = pairB2b(seen, 'js-b2b', 'dd');
  assert.equal(paired[0].b2b, undefined); // solo set untouched
  assert.deepEqual(paired[1].b2b, ['dom dolla']);
  assert.deepEqual(paired[2].b2b, ['john summit']);

  // Unpair js-b2b
  const left = leaveB2b(paired, 'js-b2b');
  assert.equal(left[0].b2b, undefined);
  assert.equal(left[1].b2b, undefined);
  assert.equal(left[2].b2b, undefined);
});
