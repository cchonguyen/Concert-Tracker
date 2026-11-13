import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { confirmLookup, isReaderExtractor } from '../src/server/lineup/learning.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';

test('isReaderExtractor accepts gemini: and workers-ai: only', () => {
  assert.equal(isReaderExtractor('gemini:gemini-3.5-flash-lite'), true);
  assert.equal(isReaderExtractor('workers-ai:@cf/meta/llama'), true);
  assert.equal(isReaderExtractor('clashfinder'), false);
  assert.equal(isReaderExtractor('user'), false);
  assert.equal(isReaderExtractor('gemini'), false);
  assert.equal(isReaderExtractor('openai:x'), false);
  assert.equal(isReaderExtractor(''), false);
});

const NAMES = ['Alpha Act', 'Beta Band', 'Gamma Group'];

async function exampleCount(extractor: string): Promise<number> {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'reader-prefix-')));
  const doc = makeDocument('https://fest.example/lineup', 'promoter', NAMES.join('\n'), 'text');
  await store.putDocument(doc);
  const performers = NAMES.map((name) => ({
    key: name.toLowerCase(),
    name,
    days: [],
    stages: [],
    status: 'billed' as const,
    confidence: 0.9,
    flagged: false,
    sources: [{ sourceType: 'promoter' as const, sourceUrl: doc.url, quotedSpan: name, evidence: 'billed' as const, extractor }],
  }));
  await store.addPerformerClaims(
    NAMES.map((name, i) => ({
      id: `claim-${i}`,
      jobId: 'job-1',
      documentId: doc.id,
      sourceType: 'promoter' as const,
      sourceUrl: doc.url,
      name,
      quotedSpan: name,
      evidence: 'billed' as const,
      extractor,
      extractorVersion: '1',
      createdAt: '2025-06-01',
    })),
  );
  const job = {
    id: 'job-1',
    kind: 'lineup' as const,
    input: { eventName: 'Fest', year: 2025 },
    editionKey: 'fest/2025',
    status: 'needs_review' as const,
    stage: 'done' as const,
    attempts: 1,
    pendingExtraction: [],
    discoveryDone: true,
    facts: {},
    candidate: { editionKey: 'fest/2025', cached: false, facts: { sources: {} }, performers, droppedCount: 0 },
    log: [],
    createdAt: '2025-06-01',
    updatedAt: '2025-06-01',
  };
  await store.createJob(job);
  await confirmLookup(store, job, {
    facts: { name: 'Fest' },
    performers: performers.map((p) => ({ key: p.key, name: p.name, accepted: true, seen: false })),
  });
  return (await store.getExamples('fest.example')).length;
}

test('learning treats workers-ai: like gemini:, and ignores other extractors', async () => {
  assert.equal(await exampleCount('gemini:x'), 1);
  assert.equal(await exampleCount('workers-ai:x'), 1);
  assert.equal(await exampleCount('promoter'), 0);
});
