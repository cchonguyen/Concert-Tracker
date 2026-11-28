import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DRAFT_LINK_REASON, ensureDraftEdition } from '../src/server/canon/draftEdition.ts';
import { runAutoLink } from '../src/server/canon/autoLink.ts';
import { NOTICE_SETTING, NOTICE_VERSION } from '../src/server/auth/routes.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const now = new Date('2026-11-28T00:00:00.000Z');
const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'draft-')));
const ev = (over: Record<string, unknown> = {}): LoggedEvent =>
  ({
    id: 'd1',
    input: 'Glass Animals',
    name: 'Glass Animals',
    startDate: '2026-03-04',
    year: 2026,
    venue: 'Fox Theatre',
    city: 'Oakland',
    sources: { venue: { sourceType: 'user' }, city: { sourceType: 'user' } },
    details: { status: 'none', candidates: [], notes: [] },
    seen: [{ key: 'glass animals', name: 'Glass Animals', from: 'you' }],
    notes: 'a private note',
    companions: ['Sam'],
    rating: 5,
    createdAt: '2026-03-05T00:00:00.000Z',
    updatedAt: '2026-03-05T00:00:00.000Z',
    ...over,
  }) as unknown as LoggedEvent;

test('an unlinked dated event gets a provisional edition and is linked, reason recorded', async () => {
  const store = await fresh();
  const d = await ensureDraftEdition(store, ev(), now);
  assert.ok(d);
  assert.equal(d.edition.status, 'provisional');
  assert.equal(d.event.editionId, d.edition.id);
  assert.equal(d.event.details?.autoLinked?.reason, DRAFT_LINK_REASON);
  assert.equal(d.event.details?.autoLinked?.editionId, d.edition.id);
});

test('the draft edition holds no personal field', async () => {
  const store = await fresh();
  const d = await ensureDraftEdition(store, ev(), now);
  assert.ok(d);
  const json = JSON.stringify(d.edition);
  assert.doesNotMatch(json, /private note|"Sam"|companions|"rating"/);
  assert.ok(!json.includes('"d1"'), 'the event id is not in the edition');
  assert.equal(d.edition.venue, 'Fox Theatre');
});

test('an untyped venue is not passed to the edition', async () => {
  const store = await fresh();
  const d = await ensureDraftEdition(store, ev({ sources: {} }), now);
  assert.ok(d);
  assert.equal(d.edition.venue, undefined);
  assert.equal(d.edition.city, undefined);
});

test('an event without a full start date gets no draft', async () => {
  const store = await fresh();
  assert.equal(await ensureDraftEdition(store, ev({ startDate: '2026-03' }), now), null);
});

test('an event already linked, deleted or marked missed gets no draft', async () => {
  const store = await fresh();
  assert.equal(await ensureDraftEdition(store, ev({ editionId: 'x' }), now), null);
  assert.equal(await ensureDraftEdition(store, ev({ deletedAt: '2026-03-06T00:00:00.000Z' }), now), null);
  assert.equal(await ensureDraftEdition(store, ev({ attendance: 'missed' }), now), null);
});

test('an edition the person unlinked before is not linked again', async () => {
  const store = await fresh();
  const first = await ensureDraftEdition(store, ev(), now);
  assert.ok(first);
  const again = await ensureDraftEdition(store, ev({ id: 'd2', details: { status: 'none', candidates: [], notes: [], autoLinkDeclined: [first.edition.id] } }), now);
  assert.equal(again, null);
});

test('runAutoLink drafts an unlinked owner event; its Who I Saw act becomes a candidate', async () => {
  const store = await fresh();
  const owner = store.forUser({ userId: 'owner', role: 'owner' });
  await owner.putEvent(ev());
  const report = await runAutoLink(store, [{ userId: 'owner', role: 'owner' }], { now });
  assert.equal(report?.drafted, 1);
  const [saved] = await owner.listEvents();
  assert.ok(saved.editionId);
  const edition = await store.getEdition(saved.editionId!);
  assert.deepEqual(edition?.performances.map((p) => [p.artistKey, p.verification]), [['glass animals', 'candidate']]);
});

test('runAutoLink does not draft for a member without the current notice, and drafts once they accept it', async () => {
  const store = await fresh();
  const member = store.forUser({ userId: 'm1', role: 'member' });
  await member.putEvent(ev({ id: 'm-e1' }));
  const members = [{ userId: 'm1', role: 'member' }];
  const before = await runAutoLink(store, members, { now });
  assert.equal(before?.drafted ?? 0, 0);
  assert.equal((await member.listEvents())[0].editionId, undefined);

  await member.putSetting(NOTICE_SETTING, { version: NOTICE_VERSION, acceptedAt: now.toISOString() });
  const after = await runAutoLink(store, members, { now });
  assert.equal(after?.drafted, 1);
  assert.ok((await member.listEvents())[0].editionId);
});

test('runAutoLink marks an event it cannot draft and skips it on the next run', async () => {
  const store = await fresh();
  const owner = store.forUser({ userId: 'owner', role: 'owner' });
  const first = await ensureDraftEdition(store, ev(), now);
  assert.ok(first);
  await owner.putEvent(ev({ details: { status: 'none', candidates: [], notes: [], autoLinkDeclined: [first.edition.id] } }));
  const report = await runAutoLink(store, [{ userId: 'owner', role: 'owner' }], { now });
  assert.equal(report?.drafted ?? 0, 0);
  const [saved] = await owner.listEvents();
  assert.equal(saved.editionId, undefined);
  assert.equal(saved.details.draftTriedAt, now.toISOString());
  let calls = 0;
  const again = await runAutoLink(store, [{ userId: 'owner', role: 'owner' }], { now, budgetLeft: () => (calls++, 1000) });
  assert.equal(again?.drafted ?? 0, 0);
  assert.equal((await owner.listEvents())[0].details.draftTriedAt, now.toISOString());
});
