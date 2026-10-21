import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEvent } from '../src/server/events/service.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { eventTitle, eventTitleParts } from '../src/services/series.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const ev = (line: string, extra: Partial<LoggedEvent> = {}): LoggedEvent => ({ ...newEvent(line, NOW), ...extra });
const act = (name: string, extra: Partial<LoggedEvent['seen'][number]> = {}) => ({
  key: name.toLowerCase(),
  name,
  from: 'you' as const,
  ...extra,
});

test('an event with one or two main acts shows them before its name', () => {
  const e = ev('Alive Tour', { seen: [act('Gryffin'), act('Said the Sky', { role: 'support' })] });
  assert.equal(eventTitle(e), 'Gryffin - Alive Tour');
  assert.equal(e.name, 'Alive Tour');
  assert.equal(eventTitle({ ...e, seen: [act('Above & Beyond'), act('Seven Lions')] }), 'Above & Beyond, Seven Lions - Alive Tour');
});

test('two main acts that played B2B show as a B2B', () => {
  const e = ev('Pier Party', { seen: [act('Sasha', { b2b: ['john digweed'] }), act('John Digweed', { b2b: ['sasha'] })] });
  assert.equal(eventTitle(e), 'Sasha b2b John Digweed - Pier Party');
});

test('the name stays as typed when it names an act, has three or more, is a festival or in a series', () => {
  const e = ev('Gryffin Alive Tour', { seen: [act('Gryffin')] });
  assert.equal(eventTitle(e), 'Gryffin Alive Tour');
  const tour = ev('Alive Tour', { seen: [act('Gryffin')] });
  assert.equal(eventTitle({ ...tour, seen: [act('A'), act('B'), act('C')] }), 'Alive Tour');
  assert.equal(eventTitle({ ...tour, seen: [] }), 'Alive Tour');
  assert.equal(eventTitle({ ...tour, kind: 'festival' }), 'Alive Tour');
  assert.equal(eventTitle({ ...tour, startDate: '2024-05-17', endDate: '2024-05-19' }), 'Alive Tour');
  assert.equal(eventTitle({ ...tour, series: 'Alive Tour' }), 'Alive Tour');
});

test('the title in parts: the acts, and the name set apart from them', () => {
  const e = ev('Alive Tour', { seen: [act('Gryffin')] });
  assert.deepEqual(eventTitleParts(e), { artists: 'Gryffin', name: 'Alive Tour' });
  assert.deepEqual(eventTitleParts({ ...e, seen: [] }), { name: 'Alive Tour' });
});
