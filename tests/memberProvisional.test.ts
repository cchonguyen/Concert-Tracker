import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { researchCatalogFor, researchEvent } from '../src/server/events/details.ts';
import { newEvent } from '../src/server/events/service.ts';
import { upsertOccurrence } from '../src/server/canon/match.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-20T12:00:00Z');
const store = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'memprov-')));
const run = (store: FileLineupStore, ev: ReturnType<typeof newEvent>) =>
  researchEvent(ev, [], fakeFetcher({}).fetcher, NOW, undefined, researchCatalogFor('member', 'u2', store));

test('member entry creates one provisional edition with only name, date, venue and city', async () => {
  const s = await store();
  const ev = { ...newEvent('Porter Robinson at Greek Theatre, Los Angeles, Oct 5 2024', NOW), companions: 'Sam', notes: 'great', rating: 5, price: 80 } as any;
  const out = await run(s, ev);
  const rows = await s.listEditions(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'provisional');
  assert.equal(rows[0].name, 'Porter Robinson');
  assert.equal(rows[0].startDate, '2024-10-05');
  assert.equal(rows[0].venue, 'Greek Theatre');
  assert.equal(rows[0].city, 'Los Angeles');
  assert.equal(rows[0].country, undefined);
  assert.equal(rows[0].endDate, undefined);
  const json = JSON.stringify(rows[0]);
  for (const p of ['Sam', 'great']) assert.ok(!json.includes(p));
  const changes = await s.listEditionChanges(rows[0].id);
  assert.equal(changes.length, 1);
  assert.ok(JSON.stringify(changes[0]).includes('member:entry'));
  assert.ok(JSON.stringify(changes[0]).includes('Member entry'));
  assert.equal(out.details.status, 'off');
});

test('a year-only event writes nothing', async () => {
  const s = await store();
  await run(s, newEvent('Porter Robinson 2024', NOW));
  assert.equal((await s.listEditions(10)).length, 0);
});

test('a verified catalog hit is not written over', async () => {
  const s = await store();
  await upsertOccurrence(s, { name: 'Porter Robinson', startDate: '2024-10-05', venue: 'Greek Theatre', city: 'Los Angeles', subjectKey: 'porter-robinson', trust: 'verified', actor: 'system:test', reason: 'test' });
  const before = (await s.listEditions(10))[0];
  const out = await run(s, newEvent('Porter Robinson at Greek Theatre, Los Angeles, Oct 5 2024', NOW));
  const rows = await s.listEditions(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'verified');
  assert.equal((await s.listEditionChanges(before.id)).length, 1);
  assert.ok(!out.details.notes.some((n) => n.includes('your entry')));
});
