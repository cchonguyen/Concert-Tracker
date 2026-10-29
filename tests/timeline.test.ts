import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggedEvent } from '../src/server/events/types.ts';
import {
  actsStep,
  addDays,
  agendaBlocks,
  agendaCount,
  agendaOrderFrom,
  AgendaBlock,
  buildTimelineModel,
  dateChip,
  daysBetween,
  firstToConfirm,
  gapLabel,
  heatmapRows,
  heatmapYear,
  riverLayout,
  riverStretch,
  monthFromQuery,
  monthPage,
  monthToQuery,
  dayNumber,
  shiftMonth,
  spanBounds,
  spanInRange,
  weekday,
} from '../src/services/timeline.ts';

const ev = (id: string, patch: Partial<LoggedEvent>): LoggedEvent => ({
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

const TODAY = '2026-10-28';

test('day maths stays on calendar days across month, year, leap day and clock changes', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // US clocks change that night
  assert.deepEqual(daysBetween('2026-11-01', '2026-11-03'), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(weekday('2026-10-28'), 3); // a Wednesday
});

test('span bounds use start and end, else the ticked days, else one day', () => {
  assert.deepEqual(spanBounds({ startDate: '2024-04-12', endDate: '2024-04-14', daysAttended: [] }), { first: '2024-04-12', last: '2024-04-14' });
  assert.deepEqual(spanBounds({ startDate: '2024-04-12', daysAttended: [] }), { first: '2024-04-12', last: '2024-04-12' });
  assert.deepEqual(spanBounds({ daysAttended: ['2024-04-14', '2024-04-12'] }), { first: '2024-04-12', last: '2024-04-14' });
  assert.deepEqual(spanBounds({ startDate: '2024-04-12', daysAttended: ['2024-04-12', '2024-04-14'] }), { first: '2024-04-12', last: '2024-04-14' });
  assert.deepEqual(spanBounds({ startDate: '2024-04-12', endDate: '2024-04-10', daysAttended: [] }), { first: '2024-04-12', last: '2024-04-12' });
  assert.equal(spanBounds({ daysAttended: [] }), null);
});

test('no days ticked means every day; ticked days are the only ones lit', () => {
  const m = buildTimelineModel(
    [
      ev('all', { startDate: '2024-04-12', endDate: '2024-04-14' }),
      ev('sat', { startDate: '2025-04-11', endDate: '2025-04-13', daysAttended: ['2025-04-12'] }),
    ],
    TODAY,
  );
  assert.deepEqual(m.spans.find((s) => s.id === 'all')!.days, ['2024-04-12', '2024-04-13', '2024-04-14']);
  assert.deepEqual(m.spans.find((s) => s.id === 'sat')!.days, ['2025-04-12']);
  assert.ok(m.days['2025-04-12']);
  assert.equal(m.days['2025-04-11'], undefined); // a festival day you skipped stays unlit
});

test("year-only and month-only events are never placed on a day; no date at all goes in the tray; didn't go is left out", () => {
  const m = buildTimelineModel(
    [
      ev('month', { year: 2019, month: 3 }),
      ev('year', { year: 2019 }),
      ev('none', {}),
      ev('missed', { startDate: '2024-05-01', attendance: 'missed' }),
    ],
    TODAY,
  );
  assert.deepEqual(m.spans, []);
  assert.deepEqual(Object.keys(m.days), []);
  assert.deepEqual(m.partial.map((p) => p.id), ['year', 'month']);
  assert.deepEqual(m.undated.map((e) => e.id), ['none']);
  assert.equal(m.first, undefined);
});

test('a day holds every event on it and shows the strongest state', () => {
  const m = buildTimelineModel(
    [
      ev('fest', { startDate: '2026-04-10', endDate: '2026-04-12', kind: 'festival' }),
      ev('after', { startDate: '2026-04-11', name: 'Aftershow' }),
      ev('ask', { startDate: '2026-04-12', attendance: 'planned' }),
      ev('next', { startDate: '2026-12-31', attendance: 'planned' }),
    ],
    TODAY,
  );
  assert.deepEqual(m.days['2026-04-11'].events.map((s) => s.id), ['fest', 'after']);
  assert.equal(m.days['2026-04-11'].state, 'festival');
  assert.equal(m.days['2026-04-12'].state, 'confirm');
  assert.equal(m.days['2026-12-31'].state, 'upcoming');
  assert.equal(m.toConfirm, 1);
  assert.equal(m.first, '2026-04-10');
  assert.equal(m.last, '2026-12-31');
});

test('a show with an unknown type counts as a show, not a festival', () => {
  const m = buildTimelineModel([ev('x', { startDate: '2023-06-01' })], TODAY);
  assert.equal(m.spans[0].kind, undefined);
  assert.equal(m.days['2023-06-01'].state, 'show');
});

test('two weekends stay two events, each with its weekend and title', () => {
  const m = buildTimelineModel(
    [
      ev('w1', { name: 'Coachella', series: 'Coachella Indio', startDate: '2024-04-12', endDate: '2024-04-14', weekend: 1 }),
      ev('w2', { name: 'Coachella', series: 'Coachella Indio', startDate: '2024-04-19', endDate: '2024-04-21', weekend: 2 }),
    ],
    TODAY,
  );
  assert.deepEqual(m.spans.map((s) => s.weekend), [1, 2]);
  assert.equal(m.days['2024-04-16'], undefined); // the weekdays between are not lit
  assert.match(m.spans[1].title, /Weekend 2/);
});

test('spans are matched to a year or month range by any day they touch', () => {
  const span = { first: '2025-12-30', last: '2026-01-02' };
  assert.ok(spanInRange(span, { kind: 'all' }));
  assert.ok(spanInRange(span, { kind: 'year', year: 2025 }));
  assert.ok(spanInRange(span, { kind: 'year', year: 2026 }));
  assert.ok(spanInRange(span, { kind: 'month', year: 2026, month: 1 }));
  assert.ok(!spanInRange(span, { kind: 'month', year: 2026, month: 2 }));
  assert.ok(spanInRange({ first: '2024-02-29', last: '2024-02-29' }, { kind: 'month', year: 2024, month: 2 }));
});

test('river dot size steps up with acts, and no acts logged draws like one', () => {
  assert.deepEqual([0, 1, 2, 4, 5, 9, 10, 40].map(actsStep), [1, 1, 2, 2, 3, 3, 4, 4]);
});

// A readable outline of the agenda: "2019", "2019-03: a, b", "gap Apr 2019 – Dec 2020".
const outline = (blocks: AgendaBlock[]) =>
  blocks.map((b) => {
    if (b.kind === 'year') return String(b.year);
    if (b.kind === 'gap') return `gap ${gapLabel(b)}`;
    const rows = b.rows.map((r) => (r.kind === 'today' ? 'TODAY' : r.kind === 'span' ? r.span.id : `~${r.partial.id}`));
    return `${b.year}-${b.month ? String(b.month).padStart(2, '0') : '??'}: ${rows.join(', ')}`;
  });

test('agenda runs oldest first by month under each year, with one gap line per run of empty months', () => {
  const m = buildTimelineModel(
    [
      ev('mar', { startDate: '2019-03-09' }),
      ev('mar2', { startDate: '2019-03-02' }),
      ev('jan21', { startDate: '2021-01-15' }),
      ev('feb21', { startDate: '2021-02-01' }),
      ev('apr21', { startDate: '2021-04-30', endDate: '2021-05-02' }),
    ],
    TODAY,
  );
  assert.deepEqual(outline(agendaBlocks(m)), [
    '2019',
    '2019-03: mar2, mar',
    'gap Apr 2019 – Dec 2020',
    '2021',
    '2021-01: jan21',
    '2021-02: feb21',
    'gap Mar 2021',
    '2021-04: apr21', // a run into May stays in the month it starts
    'gap May 2021 – Sep 2026',
    '2026',
    '2026-10: TODAY',
  ]);
});

test('newest first reads the same list backwards, with gaps and the Today line in place', () => {
  const m = buildTimelineModel(
    [
      ev('mar', { startDate: '2019-03-09' }),
      ev('mar2', { startDate: '2019-03-02' }),
      ev('jan21', { startDate: '2021-01-15' }),
      ev('feb21', { startDate: '2021-02-01' }),
      ev('apr21', { startDate: '2021-04-30', endDate: '2021-05-02' }),
    ],
    TODAY,
  );
  assert.deepEqual(outline(agendaBlocks(m, { kind: 'all' }, true, 'newest')), [
    '2026',
    '2026-10: TODAY',
    'gap May 2021 – Sep 2026',
    '2021',
    '2021-04: apr21',
    'gap Mar 2021',
    '2021-02: feb21',
    '2021-01: jan21',
    'gap Apr 2019 – Dec 2020',
    '2019',
    '2019-03: mar, mar2',
  ]);
  assert.equal(agendaCount(agendaBlocks(m, { kind: 'all' }, true, 'newest')), 5);
});

test('agenda order is newest unless oldest was picked, and the count leaves out the Today line', () => {
  assert.equal(agendaOrderFrom(null), 'newest');
  assert.equal(agendaOrderFrom('oldest'), 'oldest');
  assert.equal(agendaOrderFrom('sideways'), 'newest');
  const m = buildTimelineModel([ev('a', { startDate: TODAY })], TODAY);
  assert.equal(agendaCount(agendaBlocks(m)), 1);
});

test('agenda puts year-only events first in their year and month-only ones first in their month', () => {
  const m = buildTimelineModel(
    [ev('day', { startDate: '2019-03-01' }), ev('month', { year: 2019, month: 3 }), ev('year', { year: 2019 })],
    TODAY,
  );
  assert.deepEqual(outline(agendaBlocks(m, { kind: 'year', year: 2019 })), ['2019', '2019-??: ~year', '2019-03: ~month, day']);
});

test('the Today line sits after events on today and before the next upcoming one', () => {
  const m = buildTimelineModel(
    [
      ev('today', { startDate: TODAY }),
      ev('soon', { startDate: '2026-10-30', attendance: 'planned' }),
      ev('ask', { startDate: '2026-10-01', attendance: 'planned' }),
    ],
    TODAY,
  );
  assert.deepEqual(outline(agendaBlocks(m)), ['2026', '2026-10: ask, today, TODAY, soon']);
  assert.equal(firstToConfirm(m), 'ask');
  assert.deepEqual(outline(agendaBlocks(buildTimelineModel([], TODAY))), []); // nothing logged: no lone Today line
});

test('date chips read like a calendar', () => {
  assert.equal(dateChip({ first: '2026-03-14', last: '2026-03-14' }), 'Sat 14');
  assert.equal(dateChip({ first: '2026-08-14', last: '2026-08-16' }), 'Fri 14 – Sun 16');
  assert.equal(dateChip({ first: '2026-07-31', last: '2026-08-02' }), 'Fri 31 – Sun 2 Aug');
});

test('a heatmap year has a square for every day, Sunday first, with 53 or 54 week columns', () => {
  const y2026 = heatmapYear(2026); // starts on a Thursday
  assert.equal(y2026.cells.length, 365);
  assert.deepEqual(y2026.cells[0], { date: '2026-01-01', week: 0, dow: 4 });
  assert.deepEqual(y2026.cells[364], { date: '2026-12-31', week: 52, dow: 4 });
  assert.equal(y2026.weeks, 53);
  assert.equal(y2026.months.length, 12);
  assert.deepEqual(y2026.months[1], { month: 2, week: 5 }); // Sun 1 Feb opens a new column
  const y2028 = heatmapYear(2028); // a leap year starting on a Saturday
  assert.equal(y2028.cells.length, 366);
  assert.equal(y2028.weeks, 54);
  assert.equal(y2028.cells.at(-1)!.date, '2028-12-31');
});

test('heatmap rows run newest first to the earliest event, keeping this year and collapsing empty years', () => {
  const m = buildTimelineModel(
    [ev('a', { startDate: '2018-06-01' }), ev('b', { startDate: '2018-08-01' }), ev('c', { year: 2024, month: 5 })],
    TODAY,
  );
  assert.deepEqual(
    heatmapRows(m).map((r) => (r.kind === 'gap' ? `gap ${r.to}-${r.from}` : `${r.year}: ${r.events} +${r.undayed.length}`)),
    ['2026: 0 +0', 'gap 2025-2025', '2024: 0 +1', 'gap 2023-2019', '2018: 2 +0'],
  );
  assert.deepEqual(heatmapRows(buildTimelineModel([], TODAY)), []);
});

test('a month page runs Sunday to Saturday and lays runs of days out as bars on separate lanes', () => {
  const m = buildTimelineModel(
    [
      ev('fest', { startDate: '2026-07-31', endDate: '2026-08-02', daysAttended: ['2026-07-31', '2026-08-02'], kind: 'festival' }),
      ev('same', { startDate: '2026-08-01' }),
      ev('later', { startDate: '2026-08-29', endDate: '2026-09-01' }),
      ev('month', { year: 2026, month: 8 }),
    ],
    TODAY,
  );
  const page = monthPage(m, 2026, 8);
  assert.equal(page.weeks.length, 6); // 1 Aug 2026 is a Saturday
  assert.deepEqual(page.weeks[0].days.map((d) => d.inMonth), [false, false, false, false, false, false, true]);
  const first = page.weeks[0].segments;
  assert.deepEqual(
    first.map((s) => [s.span.id, s.start, s.len, s.lane, s.before, s.after]),
    [
      ['fest', 5, 2, 0, false, true],
      ['same', 6, 1, 1, false, false],
    ],
  );
  assert.deepEqual(first[0].days, [
    { date: '2026-07-31', went: true },
    { date: '2026-08-01', went: false }, // a festival day you skipped
  ]);
  assert.deepEqual(page.weeks[1].segments.map((s) => [s.span.id, s.start, s.len, s.before]), [['fest', 0, 1, true]]);
  assert.deepEqual(page.weeks[4].segments.map((s) => [s.span.id, s.start, s.len, s.after]), [['later', 6, 1, true]]);
  assert.deepEqual(page.weeks[5].segments.map((s) => [s.span.id, s.start, s.len]), [['later', 0, 3]]); // Sun 30, Mon 31, Tue 1 Sep
  assert.deepEqual(page.undayed.map((p) => p.id), ['month']);
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
});

test('the Month view keeps its month in the address', () => {
  assert.deepEqual(monthFromQuery('?view=timeline&mode=month&month=2024-04', TODAY), { kind: 'month', year: 2024, month: 4 });
  assert.deepEqual(monthFromQuery('?view=timeline&mode=month', TODAY), { kind: 'month', year: 2026, month: 10 });
  assert.deepEqual(monthFromQuery('?month=2024-13', TODAY), { kind: 'month', year: 2026, month: 10 });
  assert.equal(monthToQuery({ year: 2024, month: 4 }), '2024-04');
});

test('the river places marks by date, sizes them by acts, and stacks overlapping ones on lanes', () => {
  const m = buildTimelineModel(
    [
      ev('fest', { startDate: '2025-01-02', endDate: '2025-01-04', seen: Array.from({ length: 12 }, (_, i) => ({ key: `a${i}`, name: `A${i}`, from: 'you' as const })) }),
      ev('same', { startDate: '2025-01-03' }),
      ev('later', { startDate: '2025-06-01' }),
    ],
    TODAY,
  );
  const r = riverLayout(m, 1)!;
  assert.equal(r.width, dayNumber('2027-01-01') - dayNumber('2025-01-01')); // through this year
  assert.equal(r.todayX, dayNumber(TODAY) - dayNumber('2025-01-01'));
  const by = Object.fromEntries(r.items.map((i) => [i.span.id, i]));
  assert.deepEqual([by.fest.x, by.fest.w, by.fest.r, by.fest.lane], [1, 3, 10, 0]);
  assert.deepEqual([by.same.x, by.same.w, by.same.r, by.same.lane], [2, 0, 4, 1]); // no acts logged draws like one
  assert.equal(by.later.lane, 0);
  assert.equal(by.later.label, false);
  assert.deepEqual(r.ticks.map((t) => t.label), ['2025', '2026']);
  assert.ok(riverLayout(m, 4)!.ticks.some((t) => t.label === 'Jun 2025'));
  assert.equal(riverLayout(buildTimelineModel([], TODAY), 1), null);
});

test('a river mark lists the events on its days, earliest first, up to three, and counts the rest', () => {
  const m = buildTimelineModel(
    [
      ev('long', { startDate: '2026-05-01', endDate: '2026-05-04' }),
      ev('a', { startDate: '2026-05-02', title: 'Alpha' } as Partial<LoggedEvent>),
      ev('b', { startDate: '2026-05-03' }),
      ev('c', { startDate: '2026-05-04' }),
      ev('far', { startDate: '2026-06-10' }),
    ],
    TODAY,
  );
  const long = m.spans.find((s) => s.id === 'long')!;
  const stretch = riverStretch(m, long);
  assert.deepEqual(stretch.shown.map((s) => s.id), ['long', 'a', 'b']);
  assert.equal(stretch.more, 1);
  const far = m.spans.find((s) => s.id === 'far')!;
  assert.deepEqual(riverStretch(m, far), { shown: [far], more: 0 });
});
