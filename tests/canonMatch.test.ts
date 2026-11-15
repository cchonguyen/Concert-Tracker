import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { findVerifiedEdition, matchEdition, upsertOccurrence } from '../src/server/canon/match.ts';
import { createLookup } from '../src/server/lineup/pipeline.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'cm-')));
const base = { trust: 'verified' as const, actor: 'system:test', reason: 'test', subjectKey: 'band-a' };
const ed = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1', key: 'band-a/2026-06-01', seriesSlug: 'band-a', year: 2026, name: 'Band A', startDate: '2026-06-01',
  status: 'verified', updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});

test('verified source with no match creates a verified edition and records the change', async () => {
  const s = await fresh();
  const r = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', city: 'Austin' });
  assert.equal(r.action, 'created');
  assert.equal(r.edition!.status, 'verified');
  assert.ok(r.edition!.venueId);
  assert.equal((await s.listEditionChanges(r.edition!.id)).length, 1);
});

test('provisional source creates a provisional edition', async () => {
  const s = await fresh();
  const r = await upsertOccurrence(s, { ...base, trust: 'provisional', name: 'Band A', startDate: '2026-06-01', venue: 'The Hall' });
  assert.equal(r.edition!.status, 'provisional');
});

test('no date means nothing is created', async () => {
  const s = await fresh();
  assert.deepEqual(await upsertOccurrence(s, { ...base, name: 'Band A' }), { action: 'skipped_no_date' });
  assert.equal((await s.listEditions(10)).length, 0);
});

test('same date, venue alias and subject matches; verified replaces provisional and promotes it', async () => {
  const s = await fresh();
  const a = await upsertOccurrence(s, { ...base, trust: 'provisional', name: 'band a live', startDate: '2026-06-01', venue: 'The Hall', city: 'Austin' });
  const b = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'the hall!', city: 'Austin, TX' });
  assert.equal(b.action, 'updated');
  assert.equal(b.edition!.id, a.edition!.id);
  assert.equal(b.edition!.status, 'verified');
  assert.equal(b.edition!.name, 'Band A');
  assert.equal(b.edition!.city, 'Austin, TX');
  assert.equal((await s.listEditions(10)).length, 1);
});

test('provisional source only fills empty fields and never changes a verified edition', async () => {
  const s = await fresh();
  const a = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall' });
  const b = await upsertOccurrence(s, { ...base, trust: 'provisional', name: 'Typo Name', startDate: '2026-06-01', venue: 'The Hall', city: 'Dallas' });
  assert.equal(b.edition!.id, a.edition!.id);
  assert.equal(b.edition!.name, 'Band A');
  assert.equal(b.edition!.status, 'verified');
  assert.equal(b.edition!.city, 'Dallas');
  const c = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', city: 'Houston' });
  assert.equal(c.edition!.city, 'Dallas'); // verified does not overwrite a verified value
});

test('a stored external ID wins, even with a different date and venue', async () => {
  const s = await fresh();
  const a = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', externalIds: [{ source: 'tm', externalId: '42' }] });
  const m = await matchEdition(s, { startDate: '2030-01-01', externalIds: [{ source: 'tm', externalId: '42' }] });
  assert.equal(m.kind, 'same');
  assert.equal(m.kind === 'same' && m.edition.id, a.edition!.id);
  assert.equal(m.kind === 'same' && m.via, 'external_id');
});

test('same date and city but a different venue is not merged and asks the owner', async () => {
  const s = await fresh();
  const a = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', city: 'Austin' });
  const b = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'Other Room', city: 'austin' });
  assert.equal(b.action, 'created');
  assert.notEqual(b.edition!.id, a.edition!.id);
  assert.deepEqual(b.suggestedWith, [a.edition!.id]);
  const q = await s.listReviewItems({ kind: 'merge_suggestion' });
  assert.equal(q.length, 1);
  assert.equal(q[0].editionId, b.edition!.id);
});

test('two equal candidates are ambiguous: nothing is written, a suggestion is queued', async () => {
  const s = await fresh();
  const v = await s.upsertVenue({ name: 'The Hall', city: 'Austin' });
  await writeEdition(s, { edition: ed({ id: 'x1', key: 'k1', startDate: '2026-05-31', endDate: '2026-06-02', venueId: v.id, subjectKey: 'band-a' }), actor: 'a', reason: 'r' });
  await writeEdition(s, { edition: ed({ id: 'x2', key: 'k2', startDate: '2026-06-01', endDate: '2026-06-03', venueId: v.id, subjectKey: 'band-a' }), actor: 'a', reason: 'r' });
  const r = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall' });
  assert.equal(r.action, 'ambiguous');
  assert.equal((await s.listEditions(10)).length, 2);
  assert.equal((await s.listReviewItems({ kind: 'merge_suggestion' })).length, 1);
  await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall' });
  assert.equal((await s.listReviewItems({ kind: 'merge_suggestion' })).length, 1); // not queued twice
});

test('upsertOccurrence collapses ambiguous match when one is 0-lineup and the other is verified populated', async () => {
  const s = await fresh();
  const v = await s.upsertVenue({ name: 'The Hall', city: 'Austin' });
  // x1 covers 2026-06-01 and is empty
  await writeEdition(s, { edition: ed({ id: 'x1', key: 'k1', startDate: '2026-05-31', endDate: '2026-06-02', venueId: v.id, subjectKey: 'band-a', performances: [] }), actor: 'a', reason: 'r' });
  // x2 starts 2026-06-01 and is verified and populated
  await writeEdition(s, {
    edition: ed({
      id: 'x2',
      key: 'k2',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      venueId: v.id,
      subjectKey: 'band-a',
      performances: [{
        artistKey: 'band-a',
        name: 'Band A',
        days: [],
        stages: [],
        status: 'billed',
        confidence: 1,
        sources: [{ sourceType: 'promoter', sourceUrl: 'https://example.com', quotedSpan: 'Band A', evidence: 'billed', extractor: 'user' }],
      }],
    }),
    actor: 'a',
    reason: 'r',
  });

  const r = await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall' });
  assert.notEqual(r.action, 'ambiguous');
  assert.equal(r.edition?.id, 'x2');
  assert.equal(r.edition?.performances.length, 1);
  assert.equal(r.edition?.hasLineup, true);
  // x1 was dropped
  assert.equal(await s.getEdition('x1'), null);
});

test('no match when nothing shares the date', async () => {
  const s = await fresh();
  await upsertOccurrence(s, { ...base, name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', city: 'Austin' });
  assert.deepEqual(await matchEdition(s, { startDate: '2026-06-02', venue: 'The Hall', city: 'Austin', subjectKey: 'band-a' }), { kind: 'none' });
});

test('drafts are never matched', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: ed({ status: 'draft' }), actor: 'a', reason: 'r' });
  assert.deepEqual(await matchEdition(s, { startDate: '2026-06-01', city: 'x' }), { kind: 'none' });
  assert.equal(await findVerifiedEdition(s, { eventName: 'Band A', year: 2026, startDate: '2026-06-01' }), null);
});

test('findVerifiedEdition: dated, undated, provisional and ambiguous cases', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: ed(), actor: 'a', reason: 'r' });
  await writeEdition(s, { edition: ed({ id: 'u', key: 'band-a/2025', year: 2025, startDate: undefined, status: 'confirmed' }), actor: 'a', reason: 'r' });
  await writeEdition(s, { edition: ed({ id: 'p', key: 'band-a/2026-07-01', startDate: '2026-07-01', status: 'provisional' }), actor: 'a', reason: 'r' });
  assert.equal((await findVerifiedEdition(s, { eventName: 'Band A 2026', year: 2026, startDate: '2026-06-01' }))?.id, 'e1');
  assert.equal((await findVerifiedEdition(s, { eventName: 'Band A', year: 2025 }))?.id, 'u');
  assert.equal(await findVerifiedEdition(s, { eventName: 'Band A', year: 2026, startDate: '2026-07-01' }), null);
  assert.equal(await findVerifiedEdition(s, { eventName: 'Band A', year: 2026, startDate: '2026-08-01' }), null);
  await writeEdition(s, { edition: ed({ id: 'e2', key: 'k2' }), actor: 'a', reason: 'r' });
  assert.equal(await findVerifiedEdition(s, { eventName: 'Band A', year: 2026, startDate: '2026-06-01' }), null);
});

test('pipeline cache: a verified edition found by the matcher skips the lookup; a provisional one does not', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: ed({ key: 'differently-keyed' }), actor: 'a', reason: 'r' });
  await writeEdition(s, { edition: ed({ id: 'p', key: 'p/1', seriesSlug: 'prov', name: 'Prov', status: 'provisional' }), actor: 'a', reason: 'r' });
  const deps = { store: s, now: () => new Date('2026-02-01T00:00:00Z') } as any;
  const hit = await createLookup(deps, { eventName: 'Band A', year: 2026, startDate: '2026-06-01' });
  assert.equal(hit.status, 'needs_review');
  assert.equal(hit.editionId, 'e1');
  const miss = await createLookup(deps, { eventName: 'Prov', year: 2026, startDate: '2026-06-01' });
  assert.equal(miss.status, 'queued');
  assert.equal(miss.editionId, undefined);
});
