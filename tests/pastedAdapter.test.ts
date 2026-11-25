import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLookup, runJob, validateInput, withEditionActs, MAX_PASTED_CHARS, type PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { evidenceFromLookup } from '../src/server/canon/autoVerifyRun.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { CandidateLineup, CandidatePerformer, Edition, SourceAdapter } from '../src/server/lineup/types.ts';
import { fakeFetcher } from './fakes.ts';

const URL = 'https://www.festivaldust.com/festivals/together-as-one-2024-seattlewa/set-times';
const TEXT = `Peace\n\nLove\n\nUnity\n\nDOM DOLLA\n\n12am - 2am\n\nGREEN VELVET\n\n10:45pm - 12am\n\nPowered by Festival Dust`;

function setup() {
  const called: string[] = [];
  const spy = (id: SourceAdapter['id']): SourceAdapter => ({
    id,
    enabled: () => true,
    async collect() {
      called.push(id);
      throw new Error(`${id} must not run on a paste`);
    },
  });
  return { called, spy };
}

async function deps(): Promise<{ deps: PipelineDeps; calls: string[]; called: string[]; store: FileLineupStore }> {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pasted-')));
  const { fetcher, calls } = fakeFetcher({});
  const { called, spy } = setup();
  return {
    store,
    calls,
    called,
    deps: {
      store,
      fetcher,
      adapters: [spy('clashfinder'), spy('promoter'), spy('ticketmaster')],
      lateAdapters: [spy('setlistfm')],
      gemini: null,
      quota: null,
      reader: null,
      search: null,
      now: () => new Date('2026-11-24T21:00:00Z'),
    },
  };
}

const input = { eventName: 'Together As One', year: 2024, startDate: '2024-12-31', city: 'Seattle', pasted: { url: URL, text: TEXT } };

test('a paste runs only the pasted source: no other adapter, no fetch, straight to review with set times', async () => {
  const { deps: d, calls, called, store } = await deps();
  const job = await createLookup(d, input);
  const done = await runJob(d, job.id);
  assert.equal(done?.status, 'needs_review');
  assert.deepEqual(called, []);
  assert.deepEqual(calls, []);
  const dom = done?.candidate?.performers.find((p) => p.name.toUpperCase() === 'DOM DOLLA');
  assert.ok(dom);
  assert.deepEqual(dom.sources[0].sets, [{ day: '2024-12-31', stage: undefined, start: '2025-01-01 00:00', end: '2025-01-01 02:00' }]);
  assert.equal(dom.sources[0].sourceType, 'pasted');
  assert.equal(dom.sources[0].quotedSpan, 'DOM DOLLA\n12am - 2am');
  const claims = await store.listPerformerClaims(job.id);
  const doc = await store.getDocument(claims[0].documentId);
  assert.equal(doc?.url, URL);
  assert.equal(doc?.body, TEXT);
  assert.ok(done?.log.some((l) => l.message.startsWith('Pasted page: 2 act(s), 2 with a set time')));
});

test('a paste runs even when the edition already has acts, and keeps them', async () => {
  const { deps: d, store } = await deps();
  const first = await createLookup(d, { eventName: 'Together As One', year: 2024, startDate: '2024-12-31' });
  const edition: Edition = {
    id: 'tao24',
    key: first.editionKey,
    seriesSlug: 'together-as-one',
    year: 2024,
    name: 'Together As One',
    startDate: '2024-12-31',
    venue: 'WAMU Theater',
    city: 'Seattle',
    status: 'verified',
    updatedAt: '2026-01-01T00:00:00.000Z',
    performances: [
      { artistKey: 'blk', name: 'blk.', days: [], stages: [], status: 'billed', confidence: 0.8, sources: [] } as any,
    ],
  };
  await writeEdition(store, { edition, actor: 'owner', reason: 'test setup' });
  const job = await createLookup(d, input);
  assert.equal(job.status, 'queued');
  const done = await runJob(d, job.id);
  const names = done?.candidate?.performers.map((p) => p.name) ?? [];
  assert.ok(names.includes('blk.'));
  assert.equal(names.length, 3);
});

test('withEditionActs adds the pasted source to an act the edition has and appends new acts', () => {
  const perf = (key: string, over: Partial<CandidatePerformer> = {}): CandidatePerformer => ({
    key,
    name: key,
    days: [],
    stages: [],
    status: 'billed',
    confidence: 0.8,
    flagged: false,
    sources: [],
    ...over,
  });
  const lineup = (performers: CandidatePerformer[]): CandidateLineup => ({ editionKey: 'k', cached: false, facts: { sources: {} } as any, performers, droppedCount: 0 });
  const pastedSrc = { sourceType: 'pasted' as const, sourceUrl: URL, quotedSpan: 'METRIK\n1am - 2am', evidence: 'crowd' as const, extractor: 'pasted' };
  const officialSrc = { sourceType: 'promoter' as const, sourceUrl: 'https://pnw.togetherasonenye.com/', quotedSpan: 'Metrik', evidence: 'billed' as const, extractor: 'promoter' };
  const out = withEditionActs(
    lineup([perf('metrik', { days: ['2024-12-31'], sources: [pastedSrc] }), perf('netsky', { sources: [pastedSrc] })]),
    { ...lineup([perf('metrik', { sources: [officialSrc] }), perf('blk', { sources: [officialSrc] })]), cached: true },
  );
  assert.equal(out.cached, false);
  assert.deepEqual(out.performers.map((p) => p.key), ['metrik', 'blk', 'netsky']);
  assert.deepEqual(out.performers[0].sources.map((s) => s.sourceType), ['promoter', 'pasted']);
  assert.deepEqual(out.performers[0].days, ['2024-12-31']);
});

test('a pasted act is trusted evidence for auto-verify', () => {
  const candidate: CandidateLineup = {
    editionKey: 'k',
    cached: false,
    facts: { sources: {} } as any,
    droppedCount: 0,
    performers: [
      {
        key: 'metrik',
        name: 'Metrik',
        days: [],
        stages: [],
        status: 'billed',
        confidence: 0.85,
        flagged: false,
        sources: [{ sourceType: 'pasted', sourceUrl: URL, quotedSpan: 'METRIK\n1am - 2am', evidence: 'crowd', extractor: 'pasted' }],
      },
    ],
  };
  const [ev] = evidenceFromLookup(candidate, 'k', '2024-12-31');
  assert.equal(ev.trusted, true);
});

test('a paste needs an http link and text, and is capped in length', () => {
  assert.equal(validateInput({ ...input, pasted: { url: 'not a link', text: TEXT } }).pasted, undefined);
  assert.equal(validateInput({ ...input, pasted: { url: URL, text: '   ' } }).pasted, undefined);
  assert.deepEqual(validateInput(input).pasted, { url: URL, text: TEXT });
  assert.throws(() => validateInput({ ...input, pasted: { url: URL, text: 'x'.repeat(MAX_PASTED_CHARS + 1) } }), /too long/);
});
