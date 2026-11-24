import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { normalizeName } from '../src/server/lineup/text.ts';
import { upsertOccurrence } from '../src/server/canon/match.ts';
import { venueLocation, venueLocationOf } from '../src/server/canon/venueLocation.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(join(tmpdir(), 'venuestate-')));
const base = { trust: 'verified' as const, actor: 'system:test', reason: 'test' };

test('a "City, ST" city is split: the edition gets the bare city and its state, the venue keeps its id', async () => {
  const s = await fresh();
  const r = await upsertOccurrence(s, { ...base, name: 'Show A', startDate: '2025-05-01', venue: 'The Sphere', city: 'Las Vegas, NV' });
  assert.equal(r.action, 'created');
  const e = (r as any).edition ?? (await s.listEditionHeaders()).find((h: any) => h.name === 'Show A');
  const full = await s.getEdition(e.id);
  assert.equal(full?.city, 'Las Vegas');
  assert.equal(full?.region, 'NV');
  assert.equal(full?.country, 'United States');
  const [venue] = await s.listVenuesByAlias(normalizeName('The Sphere'));
  assert.equal(venue.region, 'NV');
  assert.deepEqual(await venueLocation(s, 'The Sphere'), { kind: 'one', location: { city: 'Las Vegas', region: 'NV', country: 'United States' } });
});

test('a state passed with its city is stored on a new edition', async () => {
  const s = await fresh();
  await upsertOccurrence(s, { ...base, name: 'Show B', startDate: '2025-06-01', venue: 'Red Rocks Amphitheatre', city: 'Morrison', region: 'CO', country: 'United States' });
  const h = (await s.listEditionHeaders()).find((x: any) => x.name === 'Show B')!;
  assert.equal((await s.getEdition(h.id))?.region, 'CO');
});

test('a venue record written "City, ST" and one written apart are the same place', () => {
  assert.equal(venueLocationOf([{ city: 'Las Vegas, NV' }, { city: 'Las Vegas', region: 'NV', country: 'United States' }]).kind, 'one');
});
