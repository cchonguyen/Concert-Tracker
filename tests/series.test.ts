import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, newEvent } from '../src/server/events/service.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { mergeSeen } from '../src/server/lineup/learning.ts';
import { b2bGroups, leaveB2b, pairB2b, seenSlots, slotLabel, toSeenInput } from '../src/server/events/seen.ts';
import { eventTitle, seriesBase, seriesList, seriesOffers, seriesSuggestions } from '../src/services/series.ts';
import { EMPTY_FILTERS, filterEvents, filtersFromQuery, filtersToQuery } from '../src/services/table.ts';
import { eventsToCsv } from '../src/services/format.ts';
import { editPatch, readList } from '../src/services/listImport.ts';

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
  assert.deepEqual(editPatch(list.rows[0], e, list.present).patch, { series: 'EDC LV' });
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
  assert.deepEqual(merged.find((s) => s.key === 'sasha'), { key: 'sasha', name: 'Sasha', from: 'lineup', set: 'dj', b2b: ['john digweed'] });
  const csv = eventsToCsv([{ ...ev('Movement 2024'), seen: merged }]);
  assert.match(csv, /,John Digweed b2b Sasha \(DJ set\),/);
});
