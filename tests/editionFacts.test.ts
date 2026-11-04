import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import {
  confirmCanonicalEdition,
  CanonicalInputError,
  editEditionFacts,
  parseCanonicalInput,
  parseEditionFacts,
} from '../src/server/lineup/canonicalIngest.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';

// Edition facts (GA4): owner-only, catalog-only, with a required source note. Blank facts stay blank.

const store = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'edition-facts-')));
const base = {
  name: 'Portola Music Festival',
  year: 2024,
  startDate: '2024-09-28',
  venue: 'Pier 80',
  city: 'San Francisco, CA',
  performers: [{ name: 'Rüfüs Du Sol', billing: 'headliner' as const, days: ['2024-09-28'], stages: ['Pier Stage'], set: 'DJ Set' }, { name: 'Lane 8' }],
};
const SAVED = 'portola-music-festival/2024-09-28';

const facts = (over: Record<string, unknown> = {}) => ({
  name: 'Portola Music Festival 2024',
  startDate: '2024-09-28',
  endDate: '2024-09-29',
  venue: 'Pier 80 (Treasure Island)',
  city: 'San Francisco, CA',
  sourceNote: 'Festival site, FAQ page',
  ...over,
});

test('a fact edit without a source note is rejected', () => {
  assert.throws(() => parseEditionFacts(facts({ sourceNote: undefined })), CanonicalInputError);
  assert.throws(() => parseEditionFacts(facts({ sourceNote: '   ' })), CanonicalInputError);
  assert.throws(() => parseEditionFacts(facts({ sourceNote: 'x'.repeat(501) })), CanonicalInputError);
});

test('a fact edit with a note saves the facts and stores the note on the edition', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;
  const saved = await editEditionFacts(s, edition.id, parseEditionFacts(facts()));
  assert.equal(saved.name, 'Portola Music Festival 2024');
  assert.equal(saved.endDate, '2024-09-29');
  assert.equal(saved.venue, 'Pier 80 (Treasure Island)');
  const again = (await s.getEdition(edition.id))!;
  assert.equal(again.factSourceNote, 'Festival site, FAQ page');
  assert.equal(again.key, SAVED, 'the key does not change with a fact edit');
  assert.equal(again.status, 'confirmed');
  assert.equal(again.performances.length, 2, 'acts are not changed by a fact edit');
});

test('a blank value stays blank (null), never defaulted', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;
  const parsed = parseEditionFacts(facts({ venue: '  ', city: '', endDate: '', startDate: null }));
  assert.equal(parsed.venue, null);
  assert.equal(parsed.city, null);
  assert.equal(parsed.endDate, null);
  assert.equal(parsed.startDate, null);
  await editEditionFacts(s, edition.id, parsed);
  const e = (await s.getEdition(edition.id))!;
  assert.equal(e.venue, undefined);
  assert.equal(e.city, undefined);
  assert.equal(e.endDate, undefined);
  assert.equal(e.startDate, undefined, 'a cleared date is not filled from the year');
});

test('a blank name is refused rather than defaulted', () => {
  assert.throws(() => parseEditionFacts(facts({ name: '' })), CanonicalInputError);
});

test('re-confirming keeps the fact source note', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;
  await editEditionFacts(s, edition.id, parseEditionFacts(facts()));
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  assert.equal((await s.getEdition(edition.id))?.factSourceNote, 'Festival site, FAQ page');
});

test('a fact edit never writes to a personal log', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;
  await editEditionFacts(s, edition.id, parseEditionFacts(facts()));
  assert.deepEqual(await s.listEvents(), []);
});

// The route is owner only and refuses a fact edit without a note with 400.
async function withRole(role: string, s: any, fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: 'u1' } as any, s, next));
  app.use('/api', entitiesRouter({ store: s } as any));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const patch = (url: string, body: unknown) =>
  fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('member gets 403 on a fact edit and the catalog is not written', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;
  const before = JSON.stringify(await s.getEdition(edition.id));
  const sentinel: any = new Proxy({}, { get: () => () => { throw new Error('store should not be reached for members'); } });
  await withRole('member', sentinel, async (url) => {
    const res = await patch(`${url}/api/manage/canonical/editions/${edition.id}/facts`, facts());
    assert.equal(res.status, 403);
  });
  assert.equal(JSON.stringify(await s.getEdition(edition.id)), before);
});

test('owner route: 400 without a note, 200 with one, and no personal log write', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;
  await withRole('owner', s, async (url) => {
    const refused = await patch(`${url}/api/manage/canonical/editions/${edition.id}/facts`, facts({ sourceNote: '' }));
    assert.equal(refused.status, 400);
    const missing = await patch(`${url}/api/manage/canonical/editions/nope/facts`, facts());
    assert.equal(missing.status, 404);
    const ok = await patch(`${url}/api/manage/canonical/editions/${edition.id}/facts`, facts());
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { edition: { factSourceNote?: string; venue?: string } };
    assert.equal(body.edition.factSourceNote, 'Festival site, FAQ page');
    assert.equal(body.edition.venue, 'Pier 80 (Treasure Island)');
  });
  assert.deepEqual(await s.listEvents(), []);
});
