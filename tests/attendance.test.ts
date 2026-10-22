import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggedEvent } from '../src/server/events/types.ts';
import { attendanceOf, isAhead, lastDay, wentTo } from '../src/server/events/attendance.ts';
import { applyPatch, newEvent } from '../src/server/events/service.ts';
import { pastEvents } from '../src/services/stats.ts';
import { EMPTY_FILTERS, filtersFromQuery, filtersToQuery, matches } from '../src/services/table.ts';
import { eventRows } from '../src/services/format.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const TODAY = '2026-10-21';
const ev = (line: string, extra: Partial<LoggedEvent> = {}): LoggedEvent => ({ ...newEvent(line, NOW), ...extra });

test('an event typed before it happens is planned; one typed after is counted', () => {
  assert.equal(newEvent('Fred again.. at the Shrine, Dec 1 2026', NOW).attendance, 'planned');
  assert.equal(newEvent('EDC Las Vegas 2027', NOW).attendance, 'planned');
  assert.equal(newEvent('Porter Robinson at the Greek, Oct 5 2024', NOW).attendance, undefined);
  // Today, a month that has begun, a year that has begun, or no date: logged after the fact.
  assert.equal(newEvent('Kaskade Oct 21 2026', NOW).attendance, undefined);
  assert.equal(newEvent('Kaskade Oct 2026', NOW).attendance, undefined);
  assert.equal(newEvent('Kaskade 2026', NOW).attendance, undefined);
  assert.equal(newEvent('Kaskade', NOW).attendance, undefined);
});

test('a planned event is upcoming until its last day, then asks whether you went', () => {
  const show = ev('Show', { startDate: '2026-10-25', attendance: 'planned' });
  assert.equal(attendanceOf(show, TODAY), 'upcoming');
  assert.equal(attendanceOf(show, '2026-10-25'), 'confirm');
  const fest = ev('Fest', { startDate: '2026-10-20', endDate: '2026-10-22', attendance: 'planned' });
  assert.equal(attendanceOf(fest, TODAY), 'upcoming');
  assert.equal(attendanceOf(fest, '2026-10-22'), 'confirm');
  assert.equal(lastDay({ year: 2026, month: 2 }), '2026-02-28');
  assert.equal(attendanceOf(ev('Month', { startDate: undefined, year: 2026, month: 10, attendance: 'planned' }), TODAY), 'upcoming');
  // A planned event with no date left can't tell, so it asks.
  assert.equal(attendanceOf(ev('Undated', { attendance: 'planned' }), TODAY), 'confirm');
  assert.equal(attendanceOf(ev('Missed', { startDate: '2026-01-01', attendance: 'missed' }), TODAY), 'missed');
  // An event saved before planning existed still waits while it is ahead.
  assert.equal(attendanceOf(ev('Old row', { startDate: '2026-11-01' }), TODAY), 'upcoming');
  assert.equal(attendanceOf(ev('Went', { startDate: '2026-10-01' }), TODAY), 'went');
  assert.equal(isAhead({ year: 2027 }, TODAY), true);
});

test('saying you went, or didn’t, is yours; moving a date ahead plans it', () => {
  const planned = ev('Show', { startDate: '2026-10-01', attendance: 'planned' });
  assert.equal(applyPatch(planned, { attendance: null }, NOW).attendance, undefined);
  assert.equal(applyPatch(planned, { attendance: 'missed' }, NOW).attendance, 'missed');
  assert.throws(() => applyPatch(planned, { attendance: 'maybe' as any }, NOW), /Attendance/);
  // Other edits leave it alone.
  assert.equal(applyPatch(planned, { rating: 4 }, NOW).attendance, 'planned');
  const went = ev('Show', { startDate: '2026-10-01' });
  assert.equal(applyPatch(went, { startDate: '2026-12-01' }, NOW).attendance, 'planned');
  assert.equal(applyPatch(went, { startDate: '2026-09-01' }, NOW).attendance, undefined);
  // A list import saves its dates through a patch, so rows still ahead are planned too.
  assert.equal(applyPatch(ev('Row'), { startDate: '2027-03-01', year: undefined }, NOW).attendance, 'planned');
  // A date moved back to the past keeps asking until you answer.
  assert.equal(applyPatch(planned, { startDate: '2026-09-01' }, NOW).attendance, 'planned');
  // You said you didn't go: a date change doesn't undo that.
  assert.equal(applyPatch({ ...went, attendance: 'missed' }, { startDate: '2027-01-01' }, NOW).attendance, 'missed');
});

test('Stats and the Artists and Map views count only events you went to', () => {
  const events = [
    ev('Went', { startDate: '2026-10-01', seen: [{ key: 'a', name: 'A', from: 'you' }] }),
    ev('Ahead', { startDate: '2026-12-01', attendance: 'planned', seen: [{ key: 'b', name: 'B', from: 'you' }] }),
    ev('Over', { startDate: '2026-10-10', attendance: 'planned', seen: [{ key: 'c', name: 'C', from: 'you' }] }),
    ev('Missed', { startDate: '2026-09-10', attendance: 'missed' }),
  ];
  assert.deepEqual(wentTo(events, TODAY).map((e) => e.name), ['Went']);
  assert.deepEqual(pastEvents(events, TODAY).map((e) => e.name), ['Went']);
  const f = { ...EMPTY_FILTERS, went: 'confirm' as const };
  assert.deepEqual(events.filter((e) => matches(e, f, undefined, undefined, TODAY)).map((e) => e.name), ['Over']);
  assert.equal(filtersToQuery(f), 'went=confirm');
  assert.equal(filtersFromQuery('went=confirm').went, 'confirm');
  assert.equal(filtersFromQuery('went=nonsense').went, 'any');
});

test('the export says whether you went, and the column is worked out, not read back', () => {
  const { header, rows } = eventRows([
    ev('Went', { startDate: '2024-10-01' }),
    ev('Ahead', { startDate: '2099-12-01', attendance: 'planned' }),
    ev('Missed', { startDate: '2024-09-10', attendance: 'missed' }),
  ]);
  const at = header.indexOf('Went');
  assert.deepEqual(rows.map((r) => r[at]), ['Yes', 'Upcoming', 'No']);
});
