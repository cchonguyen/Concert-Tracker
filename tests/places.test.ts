import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cityWithRegion, splitCity, splitEventCity } from '../src/server/events/regions.ts';
import { placeGuess } from '../src/server/events/place.ts';
import { applyPatch, newEvent } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { hasGap, placePatch } from '../src/services/table.ts';
import { eventRows } from '../src/services/format.ts';
import { readList } from '../src/services/listImport.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-21T12:00:00Z');

test('splitCity takes a US or Canadian postal code off the city and only rearranges', () => {
  assert.deepEqual(splitCity({ city: 'Las Vegas, NV' }), { city: 'Las Vegas', region: 'NV', country: 'United States' });
  assert.deepEqual(splitCity({ city: 'Toronto, ON' }), { city: 'Toronto', region: 'ON', country: 'Canada' });
  assert.deepEqual(splitCity({ city: 'Austin, TX, USA' }), { city: 'Austin', region: 'TX', country: 'United States' });
  assert.deepEqual(splitCity({ city: 'Austin, TX', country: 'USA' }), { city: 'Austin', region: 'TX', country: 'USA' }, 'a stored country stays');
  // Not a postal code, or not in the US or Canada: left as written.
  for (const place of [{ city: 'Berlin, Germany' }, { city: 'Toronto, Ontario' }, { city: 'Milan, MI', country: 'Italy' }, { city: 'Las Vegas' }, { city: 'Austin, tx' }]) {
    assert.deepEqual(splitCity(place), place);
  }
  // A stored state that disagrees keeps the city as written, unless both were just typed.
  assert.deepEqual(splitCity({ city: 'Portland, ME', region: 'OR' }), { city: 'Portland, ME', region: 'OR' });
  assert.equal(splitCity({ city: 'Portland, ME', region: 'OR' }, true).region, 'ME');
  assert.equal(splitCity({ city: 'Las Vegas, NV' }, false, false).country, undefined);
  assert.equal(cityWithRegion('Las Vegas', 'Nevada'), 'Las Vegas, NV');
  assert.equal(cityWithRegion('London', 'England'), 'London, England');
  assert.equal(cityWithRegion('Berlin'), 'Berlin');
});

test('the state and country split off the city carry the city source', () => {
  const src = { sourceType: 'ticketmaster' as const, sourceUrl: 'https://tm.example/e' };
  const out = splitEventCity({ city: 'Indio, CA', sources: { city: src } });
  assert.equal(out.city, 'Indio');
  assert.deepEqual(out.sources, { city: src, region: src, country: src });
});

test('capture and edits split "City, ST"; a state you type fills an empty country', () => {
  const e = newEvent('Porter Robinson at the Greek, Los Angeles, CA, Oct 5 2024', NOW);
  assert.equal(e.city, 'Los Angeles');
  assert.equal(e.region, 'CA');
  assert.equal(e.country, 'United States');
  assert.deepEqual(e.sources.region, { sourceType: 'user' });

  const moved = applyPatch(e, { city: 'Austin, TX' }, NOW);
  assert.equal(moved.city, 'Austin');
  assert.equal(moved.region, 'TX', 'the newly typed state replaces the old one');
  assert.equal(moved.country, 'United States');

  const bare = applyPatch(newEvent('Show in Toronto', NOW), { region: 'Ontario' }, NOW);
  assert.equal(bare.region, 'Ontario', 'kept as you typed it');
  assert.equal(bare.country, 'Canada');
  const abroad = applyPatch(newEvent('Show in London', NOW), { region: 'England' }, NOW);
  assert.equal(abroad.country, undefined, 'nothing is inferred outside the US and Canada');
  const kept = applyPatch({ ...e, country: 'USA' }, { region: 'NV' }, NOW);
  assert.equal(kept.country, 'USA', 'a stored country is never replaced');
});

test('events saved as "City, ST" before the State field read back split', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'places-')));
  const e = newEvent('Some show', NOW);
  await store.putEvent({ ...e, city: 'Chicago, IL', sources: { city: { sourceType: 'user' } } });
  const back = (await store.getEvent(e.id))!;
  assert.deepEqual([back.city, back.region, back.country], ['Chicago', 'IL', 'United States']);
});

const geo = (results: unknown[]) => fakeFetcher({ 'https://geocoding-api.open-meteo.com/': { body: { results } } });
const place = (name: string, admin1: string, country: string, code: string, population: number) => ({
  name,
  admin1,
  country,
  country_code: code,
  population,
  feature_code: 'PPL',
  latitude: 1,
  longitude: 1,
});

test('placeGuess gives the state and country only when one place clearly fits', async () => {
  const vegas = geo([
    place('Las Vegas', 'Nevada', 'United States', 'US', 641903),
    place('Las Vegas', 'New Mexico', 'United States', 'US', 13753),
    { ...place('Las Vegas', 'Nevada', 'United States', 'US', 0), feature_code: 'ADM2' },
  ]);
  const out = await placeGuess({ city: 'Las Vegas' }, vegas.fetcher);
  assert.deepEqual(out.guess, { city: 'Las Vegas', region: 'NV', country: 'United States', label: 'Las Vegas, Nevada, United States', places: 2 });

  const springfield = geo([
    place('Springfield', 'Missouri', 'United States', 'US', 169176),
    place('Springfield', 'Massachusetts', 'United States', 'US', 155929),
  ]);
  const unclear = await placeGuess({ city: 'Springfield' }, springfield.fetcher);
  assert.equal(unclear.guess, null);
  assert.match(unclear.note!, /More than one place is called Springfield/);
  const typed = await placeGuess({ city: 'Springfield', region: 'MA' }, springfield.fetcher);
  assert.equal(typed.guess?.region, 'MA', 'the state you wrote picks the place');
  assert.equal(typed.guess?.country, 'United States');

  const berlin = geo([place('Berlin', 'Land Berlin', 'Germany', 'DE', 3426354), place('Berlin', 'New Hampshire', 'United States', 'US', 10000)]);
  const written = await placeGuess({ city: 'Berlin, Germany' }, berlin.fetcher);
  assert.deepEqual(written.guess, { city: 'Berlin', region: 'Land Berlin', country: 'Germany', label: 'Berlin, Land Berlin, Germany', places: 1 });
  const usa = await placeGuess({ city: 'Berlin', country: 'USA' }, berlin.fetcher);
  assert.equal(usa.guess?.region, 'NH', '"USA" matches the United States');

  const none = await placeGuess({ city: 'Nowhere' }, geo([]).fetcher);
  assert.equal(none.guess, null);
  assert.match(none.note!, /Couldn't find/);
});

const ev = (patch: Partial<LoggedEvent>): LoggedEvent => ({
  id: 'e',
  input: 'x',
  name: 'x',
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

test('Fill gaps offers state and country only for the parts that are missing', () => {
  assert.equal(hasGap(ev({ city: 'Las Vegas' }), 'place'), true);
  assert.equal(hasGap(ev({ city: 'Las Vegas', country: 'United States' }), 'place'), true, 'a US city needs its state');
  assert.equal(hasGap(ev({ city: 'Las Vegas', region: 'NV', country: 'United States' }), 'place'), false);
  assert.equal(hasGap(ev({ city: 'Berlin', country: 'Germany' }), 'place'), false, 'a state is optional elsewhere');
  assert.equal(hasGap(ev({}), 'place'), false);

  const g = { city: 'Berlin', region: 'Land Berlin', country: 'Germany' };
  assert.deepEqual(placePatch({ city: 'Berlin, Germany' }, g), { city: 'Berlin', region: 'Land Berlin', country: 'Germany' });
  assert.deepEqual(placePatch({ city: 'Las Vegas', region: 'NV' }, { city: 'Las Vegas', region: 'NM', country: 'United States' }), {
    country: 'United States',
  });
  assert.equal(placePatch({ city: 'Las Vegas', region: 'NV', country: 'US' }, { city: 'Las Vegas', region: 'NV', country: 'United States' }), null);
});

test('the export has a State column and reading it back keeps it apart', () => {
  const { header, rows } = eventRows([ev({ name: 'Show', city: 'Las Vegas', region: 'NV', country: 'United States' })]);
  const at = header.indexOf('State');
  assert.equal(header[at - 1], 'City');
  assert.equal(rows[0][at], 'NV');
  const list = readList('Event,City,State,Country\nShow,Toronto,ON,Canada\nOld,"Austin, TX",,\n');
  assert.ok(list.present.includes('region'));
  assert.deepEqual([list.rows[0].city, list.rows[0].region], ['Toronto', 'ON']);
  assert.deepEqual([list.rows[1].city, list.rows[1].region, list.rows[1].country], ['Austin', 'TX', undefined]);
});
