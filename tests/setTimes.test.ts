import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byStartTime, chipTime } from '../src/server/events/sets.ts';

test('chipTime shows the first timed set, with the day on a multi-day event', () => {
  const sets = [
    { day: '2026-11-20', stage: 'Void', start: '2026-11-20 19:00', end: '2026-11-20 20:00' },
    { day: '2026-11-21', stage: 'Dream', start: '2026-11-21 22:00' },
  ];
  assert.equal(chipTime(sets, true), 'Fri 19:00 +1');
  assert.equal(chipTime(sets.slice(0, 1), false), '19:00');
  assert.equal(chipTime([{ day: '2026-11-20', stage: 'Void' }], true), undefined); // a stage alone is no time
  assert.equal(chipTime([], true), undefined);
});

test('byStartTime puts timed acts first by start and keeps untimed acts in order', () => {
  const acts = [
    { n: 'untimed A' },
    { n: 'late', s: '2026-11-21 23:00' },
    { n: 'untimed B' },
    { n: 'early', s: '2026-11-20 19:00' },
  ];
  assert.deepEqual(byStartTime(acts, (a) => a.s).map((a) => a.n), ['early', 'late', 'untimed A', 'untimed B']);
  const none = [{ n: 'b' }, { n: 'a' }];
  assert.equal(byStartTime(none, () => undefined), none);
});
