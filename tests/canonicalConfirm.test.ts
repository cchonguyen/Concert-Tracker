import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { confirmCanonicalEdition, CanonicalInputError, parseCanonicalInput } from '../src/server/lineup/canonicalIngest.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { reviewSubjectFromEdition, startRows } from '../src/services/reviewRows.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';

const store = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'canon-confirm-')));
const base = {
  name: 'Portola Music Festival',
  year: 2024,
  startDate: '2024-09-28',
  venue: 'Pier 80',
  city: 'San Francisco, CA',
  performers: [
    { name: 'Rüfüs Du Sol', billing: 'headliner', days: ['2024-09-28'], stages: ['Pier Stage'], set: 'DJ Set' },
    { name: 'Lane 8' },
  ],
};

test('preview writes nothing; apply writes the confirmed edition', async () => {
  const s = await store();
  const preview = await confirmCanonicalEdition(s, parseCanonicalInput(base));
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.diff.added, ['Rüfüs Du Sol', 'Lane 8']);
  assert.equal(await s.getEditionByKey('portola-music-festival/2024-09-28'), null);

  const done = await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  assert.equal(done.applied, true);
  const saved = await s.getEditionByKey('portola-music-festival/2024-09-28');
  assert.equal(saved?.status, 'confirmed');
  assert.equal(saved?.performances.length, 2);
  assert.equal(saved?.performances.find((p) => p.name === 'Rüfüs Du Sol')?.billing, 'headliner');
});

test('an act with no billing stays without a role; the owner source is recorded', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const e = await s.getEditionByKey('portola-music-festival/2024-09-28');
  const lane = e!.performances.find((p) => p.name === 'Lane 8')!;
  assert.equal(lane.billing, undefined);
  assert.equal(lane.sources[0].extractor, 'admin_curation');
  assert.equal(lane.sources[0].sourceUrl, '');
});

test('re-confirming merges: unchanged acts are reported, blank facts filled, conflicts not overwritten', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const again = await confirmCanonicalEdition(
    s,
    parseCanonicalInput({
      ...base,
      venue: 'Different Venue',
      endDate: '2024-09-29',
      performers: [{ name: 'Rüfüs Du Sol', billing: 'headliner', days: ['2024-09-28'], stages: ['Pier Stage'], set: 'DJ Set' }, { name: 'Odesza' }],
      apply: false,
    }),
  );
  assert.deepEqual(again.diff.unchanged, ['Rüfüs Du Sol']);
  assert.deepEqual(again.diff.added, ['Odesza']);
  assert.deepEqual(again.diff.filledFacts, ['endDate']);
  assert.deepEqual(again.diff.factConflicts, [{ field: 'venue', stored: 'Pier 80', sent: 'Different Venue' }]);
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, endDate: '2024-09-29', venue: 'Different Venue', performers: [{ name: 'Odesza' }], apply: true }));
  const e = await s.getEditionByKey('portola-music-festival/2024-09-28');
  assert.equal(e?.venue, 'Pier 80');
  assert.equal(e?.endDate, '2024-09-29');
  assert.equal(e?.performances.length, 3, 'stored acts are kept when the request does not name them');
});

test('accepted:false ignores an act and never removes one', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, performers: [{ name: 'Lane 8', accepted: false }], apply: true }));
  const e = await s.getEditionByKey('portola-music-festival/2024-09-28');
  assert.equal(e?.performances.length, 2);
});

test('invalid input is refused with a clear message, not defaulted', () => {
  assert.throws(() => parseCanonicalInput({ ...base, year: 'twenty' }), CanonicalInputError);
  assert.throws(() => parseCanonicalInput({ ...base, startDate: '28/09/2024' }), CanonicalInputError);
  assert.throws(() => parseCanonicalInput({ ...base, performers: [{ name: 'X', billing: 'opener' }] }), CanonicalInputError);
  assert.throws(() => parseCanonicalInput({ ...base, name: '' }), CanonicalInputError);
});

test('confirm never writes to a personal log (Invariant 7)', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  assert.deepEqual(await s.listEvents(), []);
});

const SAVED = 'portola-music-festival/2024-09-28';

// Reopening a saved edition (Edit lineup) starts the review from what is stored.
test('reopening a saved edition keeps its stored acts, billing and sources', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const saved = (await s.getEditionByKey(SAVED))!;
  const subject = reviewSubjectFromEdition(saved);
  assert.equal(subject.input.venue, 'Pier 80');
  const rows = startRows(subject.candidate!.performers, saved);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Lane 8', 'Rüfüs Du Sol']);
  assert.ok(rows.every((r) => r.accepted));
  assert.equal(rows.find((r) => r.name === 'Rüfüs Du Sol')?.billing, 'headliner');
  assert.equal(rows.find((r) => r.name === 'Lane 8')?.billing, undefined, 'no role stays Artist');
});

// The merge diff is what the server previews; saving applies that same request.
test('the merge diff is shown before saving and applying it changes only the named act', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edited = { ...base, performers: [{ name: 'Rüfüs Du Sol', billing: 'headliner', days: ['2024-09-28'], stages: ['Pier Stage'], set: 'Live' }, { name: 'Lane 8' }] };
  const preview = await confirmCanonicalEdition(s, parseCanonicalInput({ ...edited, apply: false }));
  assert.deepEqual(preview.diff.changed, ['Rüfüs Du Sol']);
  assert.deepEqual(preview.diff.unchanged, ['Lane 8']);
  assert.equal((await s.getEditionByKey(SAVED))?.performances.find((p) => p.name === 'Rüfüs Du Sol')?.set, 'DJ Set', 'preview writes nothing');

  await confirmCanonicalEdition(s, parseCanonicalInput({ ...edited, apply: true }));
  const e = await s.getEditionByKey(SAVED);
  assert.equal(e?.performances.find((p) => p.name === 'Rüfüs Du Sol')?.set, 'Live');
  assert.equal(e?.performances.length, 2);
});

// Stored acts are kept when the review leaves them out or unticks them, and a changed act keeps its quotes.
test('reconfirming a reopened edition keeps stored acts and the quotes they were stored with', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const saved = (await s.getEditionByKey(SAVED))!;
  const quoted = {
    ...saved,
    performances: saved.performances.map((p) =>
      p.name === 'Rüfüs Du Sol'
        ? { ...p, sources: [{ sourceType: 'promoter' as const, sourceUrl: 'https://example.com/line', quotedSpan: 'Rüfüs Du Sol with special guest', evidence: 'billed' as const, extractor: 'gemini' }] }
        : p,
    ),
  };
  await s.upsertEdition(quoted as any);
  const reopened = (await s.getEditionByKey(SAVED))!;
  const rows = startRows(reviewSubjectFromEdition(reopened).candidate!.performers, reopened);
  const edited = rows.map((r) => ({ name: r.name, accepted: r.accepted, billing: r.billing || undefined, days: r.days, stages: r.stages, set: r.name === 'Lane 8' ? 'Live' : r.set }));
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, performers: edited.map((p) => ({ ...p, accepted: p.name === 'Lane 8' })), apply: true }));
  const e = await s.getEditionByKey(SAVED);
  assert.equal(e?.performances.length, 2, 'an unticked stored act is not removed');
  const rufus = e!.performances.find((p) => p.name === 'Rüfüs Du Sol')!;
  assert.equal(rufus.sources[0].quotedSpan, 'Rüfüs Du Sol with special guest', 'the stored quote is kept');
  assert.equal(rufus.sources.filter((x) => x.extractor === 'admin_curation').length, 0, 'an unchanged act gets no new source');
  assert.equal(e!.performances.find((p) => p.name === 'Lane 8')?.set, 'Live');
});

test('a changed act keeps its quote and gains the owner curation source once', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const e0 = (await s.getEditionByKey(SAVED))!;
  await s.upsertEdition({ ...e0, performances: e0.performances.map((p) => (p.name === 'Lane 8' ? { ...p, sources: [{ sourceType: 'promoter' as const, sourceUrl: 'https://example.com/a', quotedSpan: 'Lane 8', evidence: 'billed' as const, extractor: 'gemini' }] } : p)) } as any);
  const edit = { ...base, performers: [{ name: 'Rüfüs Du Sol', billing: 'headliner', days: ['2024-09-28'], stages: ['Pier Stage'], set: 'DJ Set' }, { name: 'Lane 8', set: 'Live' }], apply: true };
  await confirmCanonicalEdition(s, parseCanonicalInput(edit));
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...edit, performers: [{ name: 'Lane 8', set: 'Closing' }] }));
  const lane = (await s.getEditionByKey(SAVED))!.performances.find((p) => p.name === 'Lane 8')!;
  assert.equal(lane.set, 'Closing');
  assert.equal(lane.sources.find((x) => x.quotedSpan === 'Lane 8')?.sourceUrl, 'https://example.com/a');
  assert.equal(lane.sources.filter((x) => x.extractor === 'admin_curation').length, 1);
});

test('blank facts stay blank when the review does not supply them', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, venue: undefined, city: undefined, apply: true }));
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, venue: undefined, city: undefined, apply: true }));
  const e = await s.getEditionByKey(SAVED);
  assert.equal(e?.venue, undefined);
  assert.equal(e?.city, undefined);
});

test('reopening and reconfirming never writes to a personal log', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const saved = (await s.getEditionByKey(SAVED))!;
  const rows = startRows(reviewSubjectFromEdition(saved).candidate!.performers, saved);
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, performers: rows.map((r) => ({ name: r.name, billing: r.billing || undefined })), apply: true }));
  assert.deepEqual(await s.listEvents(), []);
});

// The edition detail and the confirm preview are owner only (members get 403 before the store is read).
async function withMember(role: string, fn: (url: string) => Promise<void>) {
  const store: any = new Proxy({}, { get: () => () => { throw new Error('store should not be reached for members'); } });
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: 'u1' } as any, store, next));
  app.use('/api', entitiesRouter({ store } as any));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('member gets 403 on the edition detail and on the confirm preview', async () => {
  await withMember('member', async (url) => {
    const detail = await fetch(`${url}/api/manage/canonical/editions/abc`);
    assert.equal(detail.status, 403);
    const confirm = await fetch(`${url}/api/manage/canonical/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', year: 2024 }),
    });
    assert.equal(confirm.status, 403);
  });
});

// Saving a catalog lookup from the archive closes its line: status leaves needs_review.
test('apply closes its catalog lookup; a preview and a personal lookup are left alone', async () => {
  const s = await store();
  const job = (id: string, eventId?: string) => ({
    id, kind: 'lineup', input: { eventName: base.name, year: 2024 }, editionKey: 'portola-music-festival/2024-09-28',
    status: 'needs_review', stage: 'done', attempts: 0, log: [], eventId, createdAt: '', updatedAt: '',
  }) as any;
  await s.createJob(job('canon-1'));
  await s.createJob(job('personal-1', 'evt-1'));

  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, jobId: 'canon-1' }));
  assert.equal((await s.getJob('canon-1'))?.status, 'needs_review');

  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, jobId: 'canon-1', apply: true }));
  const closed = await s.getJob('canon-1');
  assert.equal(closed?.status, 'confirmed');
  assert.equal(closed?.editionId, (await s.getEditionByKey('portola-music-festival/2024-09-28'))?.id);

  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, jobId: 'personal-1', apply: true }));
  assert.equal((await s.getJob('personal-1'))?.status, 'needs_review');
});
