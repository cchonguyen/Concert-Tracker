import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePastedSets, readDayHeading, readTimeLine } from '../src/server/lineup/pasted.ts';

// Copied from a browser (Festival Dust set-times page for Together As One 2024), trimmed of navigation.
const FESTIVAL_DUST = `Together As One 2024 Set Times & Schedule
Dec 31st - Dec 31st · Seattle, WA
Lineup
Set Times
Day 1

6 pm

7 pm

12 am

1 am

Peace

Love

Unity

ARMAND VAN HELDEN

9:30pm - 10:45pm

DOM DOLLA

12am - 2am

GREEN VELVET

10:45pm - 12am

FURY & MC DINO

7pm - 8pm

METRIK

1am - 2am

SPACE 92

12:30am - 2am

VICTOR RUIZ

11pm - 12:30am

Powered by Festival Dust`;

const NYE = { startDate: '2024-12-31' };

test('a Festival Dust paste gives each act its times on the event date, after midnight on the next day', () => {
  const { sets } = parsePastedSets(FESTIVAL_DUST, NYE);
  const by = Object.fromEntries(sets.map((s) => [s.name, s.set]));
  assert.equal(sets.length, 7);
  assert.deepEqual(by['ARMAND VAN HELDEN'], { day: '2024-12-31', start: '2024-12-31 21:30', end: '2024-12-31 22:45' });
  assert.deepEqual(by['DOM DOLLA'], { day: '2024-12-31', start: '2025-01-01 00:00', end: '2025-01-01 02:00' });
  assert.deepEqual(by['GREEN VELVET'], { day: '2024-12-31', start: '2024-12-31 22:45', end: '2025-01-01 00:00' });
  assert.deepEqual(by['VICTOR RUIZ'], { day: '2024-12-31', start: '2024-12-31 23:00', end: '2025-01-01 00:30' });
  assert.equal(by['FURY & MC DINO']?.start, '2024-12-31 19:00');
});

test('stage names listed together at the top are not given to any act', () => {
  const { sets, unread } = parsePastedSets(FESTIVAL_DUST, NYE);
  assert.ok(sets.every((s) => s.set && !('stage' in s.set)));
  for (const line of ['Peace', 'Love', 'Unity', 'Powered by Festival Dust']) assert.ok(unread.includes(line), line);
});

test('the quote is the name line and the time line exactly as pasted', () => {
  const { sets } = parsePastedSets(FESTIVAL_DUST, NYE);
  assert.equal(sets.find((s) => s.name === 'SPACE 92')?.quote, 'SPACE 92\n12:30am - 2am');
});

test('one heading line directly before a group names its stage', () => {
  const text = `Main Stage\nAlpha\n21:00 - 22:00\nBeta\n22:00 - 23:00\nTent\nGamma\n21:30`;
  const { sets } = parsePastedSets(text, { startDate: '2025-06-01' });
  assert.deepEqual(
    sets.map((s) => [s.name, s.set?.stage, s.set?.start]),
    [
      ['Alpha', 'Main Stage', '2025-06-01 21:00'],
      ['Beta', 'Main Stage', '2025-06-01 22:00'],
      ['Gamma', 'Tent', '2025-06-01 21:30'],
    ],
  );
});

test('a multi-day event places times only under a day heading inside its dates', () => {
  const text = `Alpha\n20:00\nSaturday\nBeta\n9pm - 10pm\nDay 2\nGamma\n1am - 2am\nMonday\nDelta\n20:00`;
  const { sets } = parsePastedSets(text, { startDate: '2025-07-26', endDate: '2025-07-27' });
  const by = Object.fromEntries(sets.map((s) => [s.name, s.set]));
  assert.equal(by.Alpha, undefined); // before any day heading
  assert.deepEqual(by.Beta, { day: '2025-07-26', start: '2025-07-26 21:00', end: '2025-07-26 22:00' });
  assert.deepEqual(by.Gamma, { day: '2025-07-27', start: '2025-07-28 01:00', end: '2025-07-28 02:00' });
  assert.equal(by.Delta, undefined); // Monday is not a day of this event
  assert.equal(sets.length, 4);
});

test('time lines are read in 12 and 24 hour forms; a start with no am or pm of its own is not placed', () => {
  assert.deepEqual(readTimeLine('12am - 2am'), { start: { h: 12, m: 0, meridiem: 'am' }, end: { h: 2, m: 0, meridiem: 'am' } });
  assert.deepEqual(readTimeLine('21:30–22:45'), { start: { h: 21, m: 30 }, end: { h: 22, m: 45 } });
  assert.deepEqual(readTimeLine('9 PM'), { start: { h: 9, m: 0, meridiem: 'pm' } });
  assert.equal(readTimeLine('9:30 - 10:45pm'), null);
  assert.equal(readTimeLine('1991'), null);
  assert.equal(readTimeLine('25:00'), null);
});

test('a name followed by an unreadable time is left unread, not guessed', () => {
  const { sets, unread } = parsePastedSets(`Alpha\n9:30 - 10:45pm\nBeta\n22:00`, NYE);
  assert.deepEqual(sets.map((s) => s.name), ['Beta']);
  assert.ok(unread.includes('Alpha'));
});

test('day headings map to the event days only', () => {
  const days = ['2025-07-26', '2025-07-27'];
  assert.deepEqual(readDayHeading('Day 2', days), { day: '2025-07-27' });
  assert.deepEqual(readDayHeading('Sun', days), { day: '2025-07-27' });
  assert.deepEqual(readDayHeading('Day 3', days), { day: undefined });
  assert.equal(readDayHeading('Peace', days), null);
});
