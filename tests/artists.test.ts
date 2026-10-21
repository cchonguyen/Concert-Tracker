import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggedEvent, SeenAct } from '../src/server/events/types.ts';
import { artistSummaries, groupArtists, sortArtists } from '../src/services/artists.ts';

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
const act = (name: string, patch: Partial<SeenAct> = {}): SeenAct => ({ key: name.toLowerCase(), name, from: 'you', ...patch });

const events = [
  ev('a', { startDate: '2019-04-12', city: 'Indio', seen: [act('Odesza', { role: 'headliner' }), act('The Chemical Brothers')] }),
  ev('b', { startDate: '2023-06-01', city: 'Los Angeles', seen: [act('Odesza', { favourite: true }), act('Bonobo', { role: 'support' })] }),
  ev('c', { year: 2021, city: 'los angeles', seen: [act('ODESZA', { key: 'odesza' })] }),
  ev('d', { name: 'Undated', seen: [act('Ólafur Arnalds', { key: 'olafur arnalds' })] }),
];
const list = artistSummaries(events);
const get = (key: string) => list.find((a) => a.key === key)!;

test('artistSummaries counts events, roles, favourites, years and cities per act', () => {
  const o = get('odesza');
  assert.equal(o.events.length, 3);
  assert.deepEqual(o.events.map((e) => e.id), ['b', 'c', 'a']);
  assert.equal(o.name, 'Odesza'); // spelling from the most recent event
  assert.equal(o.headlined, 1);
  assert.equal(o.supported, 0);
  assert.equal(o.favourites, 1);
  assert.equal(o.firstYear, 2019);
  assert.equal(o.lastYear, 2023);
  assert.deepEqual(o.cities, ['Los Angeles', 'Indio']);
  assert.equal(get('bonobo').supported, 1);
  assert.equal(get('olafur arnalds').firstYear, undefined);
});

test('sortArtists orders by count, recency, first seen and name', () => {
  const names = (s: Parameters<typeof sortArtists>[1]) => sortArtists(list, s).map((a) => a.key);
  assert.deepEqual(names('most'), ['odesza', 'bonobo', 'the chemical brothers', 'olafur arnalds']);
  assert.deepEqual(names('recent'), ['bonobo', 'odesza', 'the chemical brothers', 'olafur arnalds']);
  assert.deepEqual(names('first'), ['the chemical brothers', 'odesza', 'bonobo', 'olafur arnalds']);
  // "The" is ignored and accents fold: Bonobo, Chemical, Ólafur, Odesza.
  assert.deepEqual(names('az'), ['bonobo', 'the chemical brothers', 'odesza', 'olafur arnalds']);
});

test('groupArtists heads groups by letter, times seen or year', () => {
  const labels = (s: Parameters<typeof groupArtists>[1]) => groupArtists(list, s).map((g) => `${g.label}:${g.artists.length}`);
  assert.deepEqual(labels('az'), ['B:1', 'C:1', 'O:2']);
  assert.deepEqual(labels('most'), ['Seen 3 times:1', 'Seen once:3']);
  assert.deepEqual(labels('recent'), ['2023:2', '2019:1', 'Date unknown:1']);
  assert.deepEqual(labels('first'), ['2019:2', '2023:1', 'Date unknown:1']);
});
