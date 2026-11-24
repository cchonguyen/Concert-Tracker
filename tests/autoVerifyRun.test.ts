import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AUTO_VERIFY_ACTOR, autoVerifyAfterLookup, editionFacts, evidenceFromLookup } from '../src/server/canon/autoVerifyRun.ts';
import { undoEditionChange, writeEdition } from '../src/server/canon/editions.ts';
import { recordMemberTick } from '../src/server/canon/memberTick.ts';
import { createLookup, runJob, type PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { CandidateLineup, CandidatePerformer, CandidateSource, Edition, LookupJob, SourceAdapter } from '../src/server/lineup/types.ts';
import { fakeFetcher } from './fakes.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'avr-')));
const src = (over: Partial<CandidateSource> = {}): CandidateSource => ({
  sourceType: 'promoter',
  sourceUrl: 'https://fest.example/lineup',
  quotedSpan: 'Kaskade',
  evidence: 'billed',
  extractor: 'promoter',
  ...over,
});
const performer = (name: string, sources: CandidateSource[], over: Partial<CandidatePerformer> = {}): CandidatePerformer => ({
  key: name.toLowerCase(),
  name,
  days: [],
  stages: [],
  status: 'billed',
  confidence: 0.8,
  flagged: false,
  sources,
  ...over,
});
const lineup = (performers: CandidatePerformer[], startDate = '2026-05-16'): CandidateLineup => ({
  editionKey: 'fest/2026',
  cached: false,
  facts: { startDate, sources: {} },
  performers,
  droppedCount: 0,
});
const baseEdition = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1',
  key: 'fest/2026',
  seriesSlug: 'fest',
  year: 2026,
  name: 'Fest 2026',
  startDate: '2026-05-16',
  venue: 'Big Field',
  city: 'Austin',
  status: 'provisional',
  updatedAt: '2026-01-01T00:00:00.000Z',
  performances: [],
  ...over,
});
const job = (candidate: CandidateLineup, over: Partial<LookupJob> = {}): LookupJob => ({
  id: 'j1',
  kind: 'lineup',
  input: { eventName: 'Fest', year: 2026 },
  editionKey: 'fest/2026',
  status: 'needs_review',
  stage: 'done',
  attempts: 1,
  pendingExtraction: [],
  discoveryDone: true,
  facts: {},
  candidate,
  log: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

// A provisional edition with a member's candidate tick for Kaskade.
async function withTick(over: Partial<Edition> = {}, actor = 'member:entry') {
  const s = await fresh();
  await writeEdition(s, { edition: baseEdition(over), actor, reason: 'test setup' });
  await recordMemberTick(s, { editionId: 'e1', artistKey: 'kaskade', artistName: 'Kaskade', actor: 'member:entry', reason: 'Member tick from Who I Saw' });
  return s;
}

test('evidence: promoter is trusted, search pages are not, setlist.fm and ticks never count, flagged acts are left out', () => {
  const ev = evidenceFromLookup(
    lineup([
      performer('Kaskade', [src(), src({ sourceType: 'discovered', sourceUrl: 'https://blog.example/a' }), src({ sourceType: 'setlistfm', sourceUrl: 'https://setlist.fm/x' })]),
      performer('Dom Dolla', [src({ sourceType: 'user', extractor: 'your entry', sourceUrl: '' })]),
      performer('Eric Prydz', [src()], { flagged: true }),
    ]),
    'fest/2026',
    '2026-05-16',
  );
  assert.deepEqual(
    ev.map((e) => [e.name, e.kind, e.trusted]),
    [
      ['Kaskade', 'fetched_page', true],
      ['Kaskade', 'fetched_page', false],
      ['Kaskade', 'external_id', false],
    ],
  );
  assert.deepEqual(evidenceFromLookup(lineup([performer('Kaskade', [src()])]), 'fest/2026', undefined), []);
});

test('after a lookup: a member tick listed on a fetched promoter page becomes verified, and undo puts it back', async () => {
  const s = await withTick();
  const r = await autoVerifyAfterLookup(s, job(lineup([performer('Kaskade', [src()])])));
  assert.deepEqual(r.acts, ['kaskade']);
  const got = await s.getEdition('e1');
  assert.equal(got?.performances[0].verification, 'verified');
  const change = (await s.listEditionChanges('e1'))[0];
  assert.equal(change.actor, AUTO_VERIFY_ACTOR);
  assert.ok(change.reason);
  const undo = await undoEditionChange(s, 'e1', change.id, 'owner');
  assert.equal(undo.ok, true);
  assert.equal((await s.getEdition('e1'))?.performances[0].verification, 'candidate');
});

test('after a lookup: a different date, one search page, or setlist.fm alone leaves the tick a candidate', async () => {
  for (const candidate of [
    lineup([performer('Kaskade', [src()])], '2026-05-17'),
    lineup([performer('Kaskade', [src({ sourceType: 'discovered' })])]),
    lineup([performer('Kaskade', [src({ sourceType: 'setlistfm', sourceUrl: 'https://setlist.fm/x' })])]),
  ]) {
    const s = await withTick();
    const r = await autoVerifyAfterLookup(s, job(candidate));
    assert.deepEqual(r.acts, []);
    assert.equal((await s.getEdition('e1'))?.performances[0].verification, 'candidate');
  }
});

test('after a lookup: two distinct search pages that agree verify the act', async () => {
  const s = await withTick();
  const r = await autoVerifyAfterLookup(
    s,
    job(lineup([performer('Kaskade', [src({ sourceType: 'discovered', sourceUrl: 'https://a.example' }), src({ sourceType: 'wayback', sourceUrl: 'https://b.example' })])])),
  );
  assert.deepEqual(r.acts, ['kaskade']);
});

test('edition facts: member-entered values are not verified; owner and venue-fill values are', async () => {
  const member = await withTick();
  const f1 = editionFacts((await member.getEdition('e1'))!, await member.listEditionChanges('e1'));
  assert.equal(f1.name?.verified, false);
  assert.equal(f1.act?.verified, false, 'a candidate tick is not a verified act');

  const owner = await withTick({}, 'owner');
  const e = (await owner.getEdition('e1'))!;
  await writeEdition(owner, { edition: { ...e, city: 'Austin, TX' }, actor: 'system:venue-location', reason: 'venue fill' });
  const f2 = editionFacts((await owner.getEdition('e1'))!, await owner.listEditionChanges('e1'));
  assert.equal(f2.name?.verified, true);
  assert.equal(f2.date?.verified, true);
  assert.equal(f2.venue?.verified, true);
  assert.equal(f2.location?.verified, true);
});

test('after a lookup: an owner-entered provisional edition becomes verified once its act is verified', async () => {
  const s = await withTick({}, 'owner');
  const r = await autoVerifyAfterLookup(s, job(lineup([performer('Kaskade', [src()])])));
  assert.equal(r.edition, true);
  const got = await s.getEdition('e1');
  assert.equal(got?.status, 'verified');
  assert.equal(got?.venue, 'Big Field', 'no field is overwritten');
});

test('after a lookup: a member-entered edition stays provisional even with a verified act', async () => {
  const s = await withTick();
  const r = await autoVerifyAfterLookup(s, job(lineup([performer('Kaskade', [src()])])));
  assert.deepEqual(r.acts, ['kaskade']);
  assert.equal(r.edition, false);
  assert.equal((await s.getEdition('e1'))?.status, 'provisional');
});

test('after a lookup: an undone owner write no longer counts as verified', async () => {
  const s = await withTick({}, 'owner');
  const e = (await s.getEdition('e1'))!;
  const w = await writeEdition(s, { edition: { ...e, venue: 'Other Field' }, actor: 'owner', reason: 'typo' });
  await undoEditionChange(s, 'e1', w.change!.id, 'owner');
  await writeEdition(s, { edition: { ...(await s.getEdition('e1'))!, venue: 'Member Field' }, actor: 'member:entry', reason: 'member' });
  const f = editionFacts((await s.getEdition('e1'))!, await s.listEditionChanges('e1'));
  assert.equal(f.venue?.verified, false);
});

test('pipeline: the lookup verifies a ticked act its own Clashfinder source lists, and logs it', async () => {
  const store = await fresh();
  const clash: SourceAdapter = {
    id: 'clashfinder',
    enabled: () => true,
    async collect() {
      const doc = makeDocument('https://clashfinder.com/s/fest26/', 'clashfinder', '{"acts":["Kaskade"]}', 'json');
      return {
        documents: [doc],
        performers: [{ documentId: doc.id, sourceType: 'clashfinder' as const, sourceUrl: doc.url, name: 'Kaskade', quotedSpan: 'Kaskade', evidence: 'crowd' as const, extractor: 'clashfinder', extractorVersion: 'test' }],
        facts: { startDate: [{ value: '2026-05-16', sourceType: 'clashfinder' as const, sourceUrl: doc.url }] },
        extractionQueue: [],
        notes: [],
      };
    },
  };
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [clash],
    lateAdapters: [],
    gemini: null,
    quota: null,
    reader: null,
    search: null,
    now: () => new Date('2026-06-01T12:00:00Z'),
  };
  const created = await createLookup(deps, { eventName: 'Fest', year: 2026 });
  await writeEdition(store, { edition: baseEdition({ key: created.editionKey }), actor: 'member:entry', reason: 'test setup' });
  await recordMemberTick(store, { editionId: 'e1', artistKey: 'kaskade', artistName: 'Kaskade', actor: 'member:entry', reason: 'Member tick from Who I Saw' });
  const done = await runJob(deps, created.id);
  assert.equal(done?.status, 'needs_review');
  assert.equal((await store.getEdition('e1'))?.performances[0].verification, 'verified');
  assert.ok(done?.log.some((l) => l.message.startsWith('Auto-verified 1 act')));
});
