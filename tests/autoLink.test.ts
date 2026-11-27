import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLinkEdition, isAutoLinkCandidate, linkedToEdition, runAutoLink } from '../src/server/canon/autoLink.ts';
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

test('the run links each member’s matching events through their own store', async () => {
  const events: Record<string, LoggedEvent[]> = {
    owner: [ev()],
    m1: [ev({ id: 'e2' }), ev({ id: 'e3', name: 'Nothing Like It' })],
  };
  const written: Record<string, LoggedEvent[]> = {};
  const series = [{ slug: 'tension-tour', name: 'Kylie Minogue: Tension Tour', aliases: ['Tension Tour'] }];
  const service: any = {
    listEditionHeaders: async () => [ed()],
    listSeries: async () => series,
    getSeries: async (slug: string) => series.find((s) => s.slug === slug) ?? null,
    forUser: ({ userId }: { userId: string }) => ({
      listEvents: async () => events[userId],
      putEvents: async (rows: LoggedEvent[]) => {
        written[userId] = rows;
      },
    }),
  };
  const report = await runAutoLink(service, [
    { userId: 'owner', role: 'owner' },
    { userId: 'm1', role: 'member' },
    { userId: 'b', role: 'member', blocked: true },
  ], { now });
  assert.deepEqual(report, { members: 2, linked: 2, ambiguous: 1 });
  assert.equal(written.owner[0].editionId, 'ed1');
  assert.equal(written.owner[0].seriesSlug, 'tension-tour');
  assert.deepEqual(written.m1.map((e) => e.id), ['e2']);
  assert.equal(written.b, undefined);
  // A second run finds nothing left to link.
  events.owner = written.owner;
  events.m1 = [...written.m1, events.m1[1]];
  assert.equal(await runAutoLink(service, [{ userId: 'owner', role: 'owner' }, { userId: 'm1', role: 'member' }], { now }), null);
});
