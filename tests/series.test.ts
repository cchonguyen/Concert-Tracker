import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, newEvent } from '../src/server/events/service.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { mergeSeen } from '../src/server/lineup/learning.ts';
import { b2bGroups, leaveB2b, pairB2b, seenSlots, setSolo, slotLabel, toSeenInput } from '../src/server/events/seen.ts';
import { eventTitle, seriesBase, seriesList, seriesOffers, seriesSuggestions, withPlace } from '../src/services/series.ts';
import { EMPTY_FILTERS, filterEvents, filtersFromQuery, filtersToQuery } from '../src/services/table.ts';
import { eventsToCsv } from '../src/services/format.ts';
import { fillPatch, readList } from '../src/services/listImport.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const ev = (line: string, extra: Partial<LoggedEvent> = {}): LoggedEvent => ({ ...newEvent(line, NOW), ...extra });

test('series base: the year and weekend or day number come out, nothing else', () => {
  assert.equal(seriesBase('EDC Las Vegas 2024'), 'EDC Las Vegas');
  assert.equal(seriesBase('EDC 2023 Las Vegas'), 'EDC Las Vegas');
  assert.equal(seriesBase("Coachella '19 Weekend 2"), 'Coachella');
  assert.equal(seriesBase('Lightning in a Bottle (2022)'), 'Lightning in a Bottle');
  assert.equal(seriesBase('Day Trip - 2025'), 'Day Trip');
  assert.equal(seriesBase('The 1975 2023'), 'The 1975');
});

test('an event in a series shows as series and year; the name you typed stays', () => {
  const e = applyPatch(ev('Electric Daisy Carnival LV 2024 at Las Vegas Motor Speedway, May 17 2024'), { series: '  EDC  Las Vegas ' }, NOW);
  assert.equal(e.series, 'EDC Las Vegas');
  assert.equal(e.name, 'Electric Daisy Carnival LV 2024');
  assert.equal(eventTitle(e), 'EDC Las Vegas 2024');
  assert.equal(eventTitle({ ...e, startDate: undefined, year: undefined }), 'EDC Las Vegas');
  assert.equal(applyPatch(e, { series: null }, NOW).series, undefined);
  assert.equal(eventTitle(ev('Porter Robinson 2024')), 'Porter Robinson');
});

test('series offers: same names across years, never already all linked', () => {
  const a = ev('EDC Las Vegas 2023', { city: 'Las Vegas, NV' });
  const b = ev('EDC Las Vegas 2024', { city: 'Las Vegas, NV' });
  const c = ev('edc las vegas 2025');
  const lone = ev('Porter Robinson 2024');
  const [s] = seriesSuggestions([a, b, c, lone]);
  assert.equal(s.name, 'EDC Las Vegas');
  assert.deepEqual(s.events.map((e) => e.year), [2023, 2024, 2025]);
  assert.equal(seriesSuggestions([a, b, c, lone]).length, 1);

  // Your series name wins, and a new year is offered into it.
  const linked = [a, b].map((e) => ({ ...e, series: 'EDC: Las Vegas' }));
  const [next] = seriesSuggestions([...linked, c]);
  assert.equal(next.name, 'EDC: Las Vegas');
  assert.equal(next.linked, 2);
  assert.deepEqual(seriesSuggestions(linked), []);
  assert.deepEqual(seriesList(linked).map((g) => [g.name, g.events.length]), [['EDC: Las Vegas', 2]]);
  assert.equal(seriesOffers(c, linked)[0], 'EDC: Las Vegas');
});

test('the Table filters and sorts by series', () => {
  const a = { ...ev('EDC 2023'), series: 'EDC Las Vegas' };
  const b = ev('Another show 2023');
  assert.deepEqual(filterEvents([a, b], { ...EMPTY_FILTERS, series: 'EDC Las Vegas' }).map((e) => e.id), [a.id]);
  assert.deepEqual(filterEvents([a, b], { ...EMPTY_FILTERS, q: 'vegas' }).map((e) => e.id), [a.id]);
  assert.equal(filtersFromQuery(filtersToQuery({ ...EMPTY_FILTERS, series: 'EDC Las Vegas' })).series, 'EDC Las Vegas');
});

test('series goes out in the CSV and comes back in', () => {
  const e = { ...ev('EDC 2023'), series: 'EDC Las Vegas' };
  const csv = eventsToCsv([e]);
  assert.match(csv.split('\n')[0], /^Date,End date,Year,Event,Series,/);
  const list = readList(csv.replace(',EDC Las Vegas,', ',EDC LV,'));
  assert.ok(list.present.includes('series'));
  assert.equal(list.rows[0].series, 'EDC LV');
  // Read back only into an event without one: the app's own value stands.
  assert.deepEqual(fillPatch(list.rows[0], e).patch, {});
  assert.deepEqual(fillPatch(list.rows[0], { ...e, series: undefined }).patch, { series: 'EDC LV' });
});

const act = (name: string, extra: Partial<LoggedEvent['seen'][number]> = {}) => ({
  key: name.toLowerCase(),
  name,
  from: 'you' as const,
  ...extra,
});

test('DJ set, live set and B2B are kept as yours; each act in a B2B is its own seen act', () => {
  const e = applyPatch(
    ev('Movement 2024'),
    {
      seen: [
        { name: 'Sasha', set: 'dj', b2b: ['john digweed'] },
        { name: 'John Digweed', set: 'dj' },
        { name: 'Bicep', set: 'live' },
        { name: 'Nobody', set: 'acoustic' as any, b2b: ['not here'] },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    e.seen.map((s) => [s.name, s.set, s.b2b]),
    [
      ['Sasha', 'dj', ['john digweed']],
      ['John Digweed', 'dj', ['sasha']],
      ['Bicep', 'live', undefined],
      ['Nobody', undefined, undefined],
    ],
  );
  assert.equal(e.seen.length, 4); // everyone credited
  assert.deepEqual(seenSlots(e.seen).map(slotLabel), ['Sasha b2b John Digweed (DJ set)', 'Bicep (Live set)', 'Nobody']);
  // A patch built from the event keeps every mark.
  assert.deepEqual(applyPatch(e, { seen: toSeenInput(e.seen) }, NOW).seen, e.seen);
  // Removing a partner leaves the other act on its own.
  const without = applyPatch(e, { seen: toSeenInput(e.seen.filter((s) => s.key !== 'sasha')) }, NOW);
  assert.equal(without.seen.find((s) => s.key === 'john digweed')!.b2b, undefined);
});

test('B2B pairs join into one group and can be taken apart', () => {
  let seen = [act('A'), act('B'), act('C')];
  seen = pairB2b(seen, 'a', 'b');
  seen = pairB2b(seen, 'c', 'b');
  assert.deepEqual(b2bGroups(seen), [['a', 'b', 'c']]);
  assert.equal(slotLabel(seenSlots(seen)[0]), 'A b2b B b2b C');
  seen = leaveB2b(seen, 'b');
  assert.deepEqual(b2bGroups(seen), [['a', 'c']]);
  assert.equal(slotLabel([act('A', { set: 'dj' }), act('B', { set: 'live' })]), 'A (DJ set) b2b B (Live set)');
});

test('your set marks outlive a lineup review, and the CSV lists them', () => {
  const before = [act('Sasha', { set: 'dj' as const, b2b: ['john digweed'] }), act('John Digweed', { b2b: ['sasha'] })];
  const merged = mergeSeen(before, [{ key: 'sasha', name: 'Sasha', from: 'lineup' }], new Set(['sasha']));
  const sasha = merged.find((s) => s.key === 'sasha');
  assert.ok(sasha?.id);
  assert.deepEqual({ key: sasha?.key, name: sasha?.name, from: sasha?.from, set: sasha?.set, b2b: sasha?.b2b }, { key: 'sasha', name: 'Sasha', from: 'lineup', set: 'dj', b2b: ['john digweed'] });
  const csv = eventsToCsv([{ ...ev('Movement 2024'), seen: merged }]);
  assert.match(csv, /,John Digweed b2b Sasha \(DJ set\),/);
});

test('series take the town from the city: same festival, two cities, two series', () => {
  const lv = [ev('EDC 2023', { city: 'Las Vegas, NV' }), ev('EDC 2024', { city: 'Las Vegas, NV' }), ev('EDC 2025')];
  const orl = [ev('EDC Orlando 2022', { city: 'Orlando, FL' }), ev('EDC 2023', { city: 'Orlando, FL' })];
  const groups = seriesSuggestions([...lv, ...orl]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.events.length]),
    [
      ['EDC Las Vegas', 2],
      ['EDC Orlando', 2],
    ],
  );
  // With two cities known for the name, an event with no city is not placed.
  assert.ok(!groups.some((g) => g.events.includes(lv[2])));
  // Only Las Vegas known: the event with no city joins it.
  assert.equal(seriesSuggestions(lv)[0].events.length, 3);

  // A series named without a place shows the event's town; one that says it already does not repeat it.
  assert.equal(eventTitle({ ...lv[1], series: 'EDC' }), 'EDC Las Vegas 2024');
  assert.equal(eventTitle({ ...lv[1], series: 'EDC Las Vegas' }), 'EDC Las Vegas 2024');
  assert.equal(eventTitle({ ...lv[2], series: 'EDC' }), 'EDC 2025');
  assert.equal(withPlace('Lightning in a Bottle', 'Buena Vista Lake, CA'), 'Lightning in a Bottle Buena Vista Lake');
  // A series you linked as "EDC" is offered new Las Vegas years under your name.
  const linked = lv.slice(0, 2).map((e) => ({ ...e, series: 'EDC' }));
  const [next] = seriesSuggestions([...linked, ev('EDC 2026', { city: 'Las Vegas, NV' })]);
  assert.equal(next.name, 'EDC');
  assert.equal(next.linked, 2);
});

test('series stats: editions, years in a row, cities and regulars', async () => {
  const { seriesStats } = await import('../src/services/stats.ts');
  const kaskade = { key: 'kaskade', name: 'Kaskade', from: 'you' as const };
  const lane8 = { key: 'lane 8', name: 'Lane 8', from: 'you' as const };
  const edc = [2019, 2022, 2023, 2024].map((y) =>
    ev(`EDC ${y}, May 17 ${y}`, { series: 'EDC Las Vegas', city: 'Las Vegas, NV', seen: y > 2022 ? [kaskade, lane8] : [kaskade] }),
  );
  const other = [ev('Dirtybird Campout 2021', { series: 'Campout' }), ev('Unlinked 2024')];
  const [first, second] = seriesStats([...edc, ...other]);
  assert.equal(first.name, 'EDC Las Vegas');
  assert.equal(first.editions, 4);
  assert.deepEqual(first.years, [2019, 2022, 2023, 2024]);
  assert.deepEqual(first.streak, { years: 3, from: 2022, to: 2024 });
  assert.deepEqual(first.cities, ['Las Vegas, NV']);
  assert.equal(first.acts, 2);
  assert.deepEqual(first.regulars, [
    { label: 'Kaskade', count: 4 },
    { label: 'Lane 8', count: 2 },
  ]);
  assert.equal(second.name, 'Campout');
  assert.equal(second.streak, undefined);
  assert.equal(seriesStats([other[1]]).length, 0);
});

test('weekend: picked by you, shown with the series, read back from the CSV', async () => {
  const { weekendFromName } = await import('../src/services/series.ts');
  assert.equal(weekendFromName('Coachella 2024 Weekend 2'), 2);
  assert.equal(weekendFromName('Coachella W1'), 1);
  assert.equal(weekendFromName('Coachella 2024'), undefined);
  const groups = seriesSuggestions([ev('Coachella 2024 Weekend 1', { city: 'Indio, CA' }), ev('Coachella 2024 Weekend 2', { city: 'Indio, CA' })]);
  assert.equal(groups[0].name, 'Coachella Indio');

  const e = applyPatch(ev('Coachella 2024 Weekend 1, April 12 2024', { city: 'Indio', region: 'CA' }), { series: 'Coachella', weekend: 1 }, NOW);
  assert.equal(eventTitle(e), 'Coachella Indio 2024 · Weekend 1');
  assert.throws(() => applyPatch(e, { weekend: 12 }, NOW), /Weekend/);
  assert.equal(applyPatch(e, { weekend: null }, NOW).weekend, undefined);

  const csv = eventsToCsv([e]);
  assert.match(csv.split('\n')[0], /,Series,Weekend,/);
  const list = readList(csv.replace(',Coachella,1,', ',Coachella,Weekend 2,'));
  assert.equal(list.rows[0].weekend, 2);
  assert.deepEqual(fillPatch(list.rows[0], e).patch, {});
  assert.deepEqual(fillPatch(list.rows[0], { ...e, weekend: undefined }).patch, { weekend: 2 });
});

test('an act in a B2B can also have its own solo set, credited once', () => {
  const e = applyPatch(
    ev('Movement 2025'),
    {
      seen: [
        { name: 'Sasha', set: 'dj', b2b: ['john digweed'], solo: true, soloSet: 'live' },
        { name: 'John Digweed', set: 'dj' },
        { name: 'Bicep', solo: true }, // not in a B2B: no solo set
      ],
    },
    NOW,
  );
  assert.equal(e.seen.length, 3);
  assert.deepEqual(
    e.seen.map((s) => [s.name, s.solo, s.soloSet]),
    [
      ['Sasha', true, 'live'],
      ['John Digweed', undefined, undefined],
      ['Bicep', undefined, undefined],
    ],
  );
  assert.deepEqual(seenSlots(e.seen).map(slotLabel), ['Sasha b2b John Digweed (DJ set)', 'Sasha (solo, Live set)', 'Bicep']);
  assert.deepEqual(applyPatch(e, { seen: toSeenInput(e.seen) }, NOW).seen, e.seen);
  assert.match(eventsToCsv([e]), /Sasha b2b John Digweed \(DJ set\); Sasha \(solo, Live set\)/);

  // Breaking up the B2B keeps Sasha's solo set as Sasha's set.
  const apart = leaveB2b(e.seen, 'sasha');
  assert.deepEqual(apart.find((s) => s.key === 'sasha'), { key: 'sasha', name: 'Sasha', from: 'you', set: 'live' });
  // Taking the solo set away leaves the B2B as it was.
  const noSolo = setSolo(e.seen, 'sasha', false);
  assert.deepEqual(seenSlots(noSolo).map(slotLabel), ['Sasha b2b John Digweed (DJ set)', 'Bicep']);
  // It outlives a lineup review.
  const merged = mergeSeen(e.seen, [{ key: 'sasha', name: 'Sasha', from: 'lineup' }], new Set(['sasha']));
  assert.equal(merged.find((s) => s.key === 'sasha')!.soloSet, 'live');
});
