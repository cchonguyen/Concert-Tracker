import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLinkEdition, editionFilledFrom, isAutoLinkCandidate, linkedToEdition, runAutoLink } from '../src/server/canon/autoLink.ts';
import { resolveEvent, unlinkEvent } from '../src/server/events/inherit.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const now = new Date('2026-11-28T00:00:00.000Z');
const ev = (over: Partial<LoggedEvent> = {}): LoggedEvent =>
  ({
    id: 'e1',
    input: 'Tension Tour',
    name: 'Tension Tour',
    startDate: '2025-05-02',
    year: 2025,
    venue: 'Crypto.com Arena',
    city: 'Los Angeles',
    country: 'United States',
    sources: {},
    details: { status: 'none', candidates: [], notes: [] },
    seen: [{ key: 'kylie minogue', name: 'Kylie Minogue', from: 'you' }],
    notes: 'a private note',
    createdAt: '2025-05-03T00:00:00.000Z',
    updatedAt: '2025-05-03T00:00:00.000Z',
    ...over,
  }) as unknown as LoggedEvent;
const ed = (over: Record<string, unknown> = {}) =>
  ({
    id: 'ed1',
    key: 'tension-tour-2025-05-02',
    name: 'Tension Tour',
    year: 2025,
    startDate: '2025-05-02',
    venue: 'Crypto.com Arena',
    city: 'Los Angeles',
    country: 'United States',
    status: 'verified',
    seriesSlug: 'tension-tour',
    seriesName: 'Kylie Minogue: Tension Tour',
    seriesAliases: ['Tension Tour'],
    ...over,
  }) as any;

test('an event links to the one verified edition with its date, name and venue', () => {
  assert.equal(autoLinkEdition(ev(), [ed()])?.id, 'ed1');
  // The series name or an alias also counts as the same name.
  assert.equal(autoLinkEdition(ev({ name: 'Kylie Minogue: Tension Tour' }), [ed()])?.id, 'ed1');
  // No venue on one side still links.
  assert.equal(autoLinkEdition(ev({ venue: undefined }), [ed()])?.id, 'ed1');
});

test('nothing links on a different venue, date or name, a draft, or two candidates', () => {
  assert.equal(autoLinkEdition(ev({ venue: 'The Forum' }), [ed()]), null);
  assert.equal(autoLinkEdition(ev({ startDate: '2025-05-03' }), [ed()]), null);
  assert.equal(autoLinkEdition(ev({ name: 'Summer Smash' }), [ed()]), null);
  assert.equal(autoLinkEdition(ev(), [ed({ status: 'provisional' })]), null);
  assert.equal(autoLinkEdition(ev(), [ed(), ed({ id: 'ed2' })]), null);
});

test('only an unlinked, dated, attended, kept event is a candidate', () => {
  assert.equal(isAutoLinkCandidate(ev()), true);
  assert.equal(isAutoLinkCandidate(ev({ editionId: 'x' })), false);
  assert.equal(isAutoLinkCandidate(ev({ startDate: '2025-05' })), false);
  assert.equal(isAutoLinkCandidate(ev({ attendance: 'missed' } as any)), false);
  assert.equal(isAutoLinkCandidate(ev({ deletedAt: '2026-01-01' })), false);
});

test('a link keeps what the person sees and records itself', () => {
  const mine = ev({ name: 'Vertigo World Tour', venue: 'The Wiltern', city: 'Los Angeles' });
  const edition = ed({ name: 'Vertigo', seriesName: 'Griff: Vertigo', seriesAliases: ['Vertigo', 'Vertigo World Tour'], venue: 'The Wiltern', city: undefined });
  const linked = linkedToEdition(mine, edition, now);
  assert.equal(linked.editionId, 'ed1');
  assert.equal(linked.overrides?.name, 'Vertigo World Tour');
  assert.equal(linked.overrides?.venue, undefined);
  const shown = resolveEvent(linked, edition);
  assert.equal(shown.name, 'Vertigo World Tour');
  assert.equal(shown.city, 'Los Angeles');
  assert.equal(linked.captured?.name, 'Vertigo World Tour');
  assert.deepEqual(linked.details.autoLinked, { editionId: 'ed1', at: now.toISOString(), reason: 'Same date, name and venue as exactly one verified edition' });
  // Personal fields stay as they were.
  assert.equal((linked as any).notes, 'a private note');
});

test('unlinking an automatic link stops that edition linking again', () => {
  const linked = linkedToEdition(ev(), ed(), now);
  const back = unlinkEvent(linked, now);
  assert.equal(back.editionId, undefined);
  assert.equal(back.details.autoLinked, undefined);
  assert.deepEqual(back.details.autoLinkDeclined, ['ed1']);
  assert.equal(autoLinkEdition(back, [ed()]), null);
});

test('the owner event fills only an edition\'s empty facts', () => {
  const edition = { ...ed({ city: undefined, country: undefined }), performances: [] };
  const filled = editionFilledFrom(edition, ev({ endDate: '2025-05-01' }));
  assert.equal(filled?.city, 'Los Angeles');
  assert.equal(filled?.country, 'United States');
  assert.equal(filled?.venue, 'Crypto.com Arena');
  // An end date before the start is never written, and nothing is written over a value.
  assert.equal(filled?.endDate, undefined);
  assert.equal(editionFilledFrom({ ...ed(), performances: [] }, ev({ city: 'Inglewood' })), null);
});

const fakeService = (events: Record<string, LoggedEvent[]>, edition: any) => {
  const written: Record<string, LoggedEvent[]> = {};
  const series = [{ slug: 'tension-tour', name: 'Kylie Minogue: Tension Tour', aliases: ['Tension Tour'] }];
  const editions: any[] = [];
  const changes: any[] = [];
  let current = { ...edition, performances: [] as any[] };
  const service: any = {
    listEditionHeaders: async () => [edition],
    listSeries: async () => series,
    getSeries: async (slug: string) => series.find((s) => s.slug === slug) ?? null,
    getEdition: async (id: string) => (id === current.id ? current : null),
    upsertEdition: async (e: any) => {
      current = e;
      editions.push(e);
    },
    recordEditionChange: async (c: any) => {
      const row = { ...c, id: `c${changes.length}` };
      changes.unshift(row);
      return row;
    },
    listEditionChanges: async () => changes,
    listEditionInferences: async () => [],
    forUser: ({ userId }: { userId: string }) => ({
      listEvents: async () => written[userId] ?? events[userId],
      putEvents: async (rows: LoggedEvent[]) => {
        written[userId] = rows;
      },
    }),
  };
  return { service, written, edition: () => current, editions, changes };
};

test('the run links each member\u2019s matching events through their own store and contributes back', async () => {
  const events: Record<string, LoggedEvent[]> = {
    owner: [ev()],
    m1: [ev({ id: 'e2', seen: [{ key: 'rita ora', name: 'Rita Ora', from: 'you' }] as any }), ev({ id: 'e3', name: 'Nothing Like It' })],
  };
  const f = fakeService(events, ed({ city: undefined }));
  const report = await runAutoLink(f.service, [
    { userId: 'owner', role: 'owner' },
    { userId: 'm1', role: 'member' },
    { userId: 'b', role: 'member', blocked: true },
  ], { now });
  assert.equal(report?.members, 2);
  assert.equal(report?.linked, 2);
  assert.equal(report?.ambiguous, 1);
  assert.deepEqual(report?.contributed, { events: 2, acts: 2, filled: 1 });
  assert.equal(f.written.owner[0].editionId, 'ed1');
  assert.equal(f.written.owner[0].seriesSlug, 'tension-tour');
  assert.equal(f.written.owner[0].details.contributedAt, now.toISOString());
  assert.deepEqual(f.written.m1.map((e) => e.id), ['e2']);
  assert.equal(f.written.b, undefined);
  // Both members' ticks are on the lineup as candidates; only the owner's event filled the empty city.
  assert.deepEqual(f.edition().performances.map((p: any) => [p.artistKey, p.verification]), [['kylie minogue', 'candidate'], ['rita ora', 'candidate']]);
  assert.equal(f.edition().city, 'Los Angeles');
  // A second run finds nothing left to link or contribute.
  events.owner = f.written.owner;
  events.m1 = [...f.written.m1, events.m1[1]];
  assert.equal(await runAutoLink(f.service, [{ userId: 'owner', role: 'owner' }, { userId: 'm1', role: 'member' }], { now }), null);
});

test('a member\u2019s typed place never fills a verified edition', async () => {
  const f = fakeService({ m1: [ev({ id: 'e9' })] }, ed({ city: undefined }));
  await runAutoLink(f.service, [{ userId: 'm1', role: 'member' }], { now });
  assert.equal(f.edition().city, undefined);
});

test('two different members ticking the same act verify it; one member alone does not; an undone verify stays undone', async () => {
  const tick = [{ key: 'rita ora', name: 'Rita Ora', from: 'you' }] as any;
  const members = [{ userId: 'owner', role: 'owner' }, { userId: 'm1', role: 'member' }];
  // One member, two events with the same tick: still a candidate.
  const solo = fakeService({ owner: [ev({ seen: tick }), ev({ id: 'e9', seen: tick })], m1: [] }, ed());
  const r1 = await runAutoLink(solo.service, members, { now });
  assert.equal(r1?.verifiedByTicks, 0);
  assert.deepEqual(solo.edition().performances.map((p: any) => p.verification), ['candidate']);
  // Two members: verified, recorded as system:member-verify.
  const f = fakeService({ owner: [ev({ seen: tick })], m1: [ev({ id: 'e2', seen: tick })] }, ed());
  const r2 = await runAutoLink(f.service, members, { now });
  assert.equal(r2?.verifiedByTicks, 1);
  assert.deepEqual(f.edition().performances.map((p: any) => [p.artistKey, p.verification]), [['rita ora', 'verified']]);
  const change = f.changes.find((c: any) => c.actor === 'system:member-verify');
  assert.equal(change?.reason, 'two members ticked this act');
  // Nothing about who ticked is in the change record.
  assert.doesNotMatch(JSON.stringify(change), /owner|m1|e2/);
  // The owner undoes it: the next run leaves it a candidate.
  change.undoneAt = now.toISOString();
  f.service.upsertEdition({ ...f.edition(), performances: f.edition().performances.map((p: any) => ({ ...p, verification: 'candidate' })) });
  const r3 = await runAutoLink(f.service, members, { now });
  assert.equal(r3, null);
  assert.deepEqual(f.edition().performances.map((p: any) => p.verification), ['candidate']);
});
