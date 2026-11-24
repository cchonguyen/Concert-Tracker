import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { normalizeName } from '../src/server/lineup/text.ts';
import { emptyPlaceFields, venueLocation, venueLocationOf } from '../src/server/canon/venueLocation.ts';

test('one record with a city gives one location', () => {
  assert.deepEqual(venueLocationOf([{ city: 'Morrison', region: 'CO', country: 'United States' }]), {
    kind: 'one',
    location: { city: 'Morrison', region: 'CO', country: 'United States' },
  });
});

test('a record without a city adds nothing', () => {
  assert.deepEqual(venueLocationOf([{}, { city: '  ' }]), { kind: 'none' });
  assert.equal(venueLocationOf([{}, { city: 'Morrison' }]).kind, 'one');
});

test('records that only add state or country to the same city are one location', () => {
  const r = venueLocationOf([{ city: 'Las Vegas' }, { city: 'las vegas', region: 'Nevada' }, { city: 'Las Vegas', region: 'NV', country: 'USA' }]);
  assert.equal(r.kind, 'one');
  if (r.kind === 'one') assert.deepEqual(r.location, { city: 'Las Vegas', region: 'Nevada', country: 'USA' });
});

test('different cities give choices and no answer', () => {
  const r = venueLocationOf([{ city: 'San Francisco', region: 'CA' }, { city: 'Denver', region: 'CO' }]);
  assert.equal(r.kind, 'several');
  if (r.kind === 'several') assert.deepEqual(r.choices.map((c) => c.city), ['San Francisco', 'Denver']);
});

test('the same city in different states gives choices', () => {
  assert.equal(venueLocationOf([{ city: 'Portland', region: 'OR' }, { city: 'Portland', region: 'ME' }]).kind, 'several');
});

test('only empty fields are filled; a different city stops the fill', () => {
  const loc = { city: 'Las Vegas', region: 'NV', country: 'United States' };
  assert.deepEqual(emptyPlaceFields({}, loc), loc);
  assert.deepEqual(emptyPlaceFields({ city: 'las vegas', country: 'USA' }, loc), { region: 'NV' });
  assert.deepEqual(emptyPlaceFields({ city: 'Henderson' }, loc), {});
  assert.deepEqual(emptyPlaceFields({ city: 'Las Vegas', region: 'NV', country: 'US' }, loc), {});
});

test('the store lists every record holding a name, so a name-only record does not hide the located one', async () => {
  const s = new FileLineupStore(await mkdtemp(join(tmpdir(), 'venueloc-')));
  await s.upsertVenue({ name: 'Red Rocks Amphitheatre' });
  await s.upsertVenue({ name: 'Red Rocks Amphitheatre', city: 'Morrison', region: 'CO', country: 'United States' });
  assert.equal((await s.listVenuesByAlias(normalizeName('Red Rocks Amphitheatre'))).length, 2);
  assert.deepEqual(await venueLocation(s, 'red rocks amphitheatre'), {
    kind: 'one',
    location: { city: 'Morrison', region: 'CO', country: 'United States' },
  });
  assert.deepEqual(await venueLocation(s, 'Nowhere Hall'), { kind: 'none' });
  assert.deepEqual(await venueLocation(s, '  '), { kind: 'none' });
});
