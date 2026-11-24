import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
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

test('a venue keeps a state it is given, without changing its id or a state already stored', async () => {
  const s = new FileLineupStore(await mkdtemp(join(tmpdir(), 'venueloc-')));
  const a = await s.upsertVenue({ name: 'The Sphere', city: 'Las Vegas', country: 'United States' });
  const b = await s.upsertVenue({ name: 'The Sphere', city: 'Las Vegas', region: 'NV', country: 'United States' });
  assert.equal(b.id, a.id);
  assert.equal(b.region, 'NV');
  assert.equal(a.id, 'venue:the-sphere|las-vegas||united-states');
  const c = await s.upsertVenue({ name: 'The Sphere', city: 'Las Vegas', region: 'Nevada', country: 'United States' });
  assert.equal(c.region, 'NV');
});

test('GET /api/canon/venue-location answers members with location fields only', async () => {
  const s = new FileLineupStore(await mkdtemp(join(tmpdir(), 'venueloc-')));
  await s.upsertVenue({ name: 'The Fillmore', city: 'San Francisco', country: 'United States' });
  await s.upsertVenue({ name: 'The Fillmore', city: 'Denver', country: 'United States' });
  await s.upsertVenue({ name: 'Red Rocks Amphitheatre', city: 'Morrison', region: 'CO', country: 'United States' });
  const member = express();
  member.use((_req, _res, next) => runAsMember({ role: 'member', uid: 'u1' } as any, s as any, next));
  member.use('/api', entitiesRouter({ store: s } as any));
  const one = await dispatch(member, { method: 'GET', url: '/api/canon/venue-location?name=Red%20Rocks%20Amphitheatre' });
  assert.equal(one.status, 200);
  assert.deepEqual(one.json(), { kind: 'one', location: { city: 'Morrison', region: 'CO', country: 'United States' } });
  const several = await dispatch(member, { method: 'GET', url: '/api/canon/venue-location?name=the%20fillmore' });
  assert.equal(several.json().kind, 'several');
  assert.equal(several.json().choices.length, 2);
  const none = await dispatch(member, { method: 'GET', url: '/api/canon/venue-location?name=' });
  assert.deepEqual(none.json(), { kind: 'none' });

  const anon = express();
  anon.use('/api', entitiesRouter({ store: s } as any));
  assert.equal((await dispatch(anon, { method: 'GET', url: '/api/canon/venue-location?name=x' })).status, 401);
});
