import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';
import type { EmailImport } from '../src/server/events/email/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { runCanonBackfill } from '../src/server/canon/backfill.ts';
import { newEvent } from '../src/server/events/service.ts';
import { EditionOccurrenceConflictError, SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'cb-')));
const event = (id: string, patch: Partial<LoggedEvent> = {}): LoggedEvent => ({ ...newEvent(patch.name ?? 'Band A', NOW), id, ...patch });
const dated = (id: string, name: string, startDate: string, extra: Partial<LoggedEvent> = {}) =>
  event(id, { name, startDate, venue: 'The Hall', city: 'Austin', ...extra });
const imp = (id: string, eventId: string, patch: Partial<EmailImport> = {}): EmailImport => ({
  id, key: id, status: 'added', seller: 'tm', sources: {}, messages: [], flags: [], eventId,
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...patch,
});
const edition = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1', key: 'band-a/2026-06-01', seriesSlug: 'band-a', year: 2026, name: 'Band A', startDate: '2026-06-01',
  status: 'verified', updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});

test('an owner event with a date becomes a verified edition; a repeat changes nothing', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01'));
  const r = (await runCanonBackfill(s))!;
  assert.equal(r.created, 1);
  assert.equal(r.remaining, 0);
  const [e] = await s.listEditions(10);
  assert.equal(e.status, 'verified');
  assert.equal(e.name, 'Band A');
  assert.ok(e.venueId);
  assert.equal(e.subjectKey, 'band-a');
  const changes = (await s.listEditionChanges(e.id)).length;
  // Complete: no more work and no reads of the event log.
  assert.equal(await runCanonBackfill(s), null);
  // Even with the cursor wiped, the upsert finds the same edition and changes nothing.
  await s.putSetting('canon_backfill', { done: [] });
  const again = (await runCanonBackfill(s))!;
  assert.equal(again.created, 0);
  assert.equal(again.matched, 1);
  assert.equal((await s.listEditions(10)).length, 1);
  assert.equal((await s.listEditionChanges(e.id)).length, changes);
});

test('at most 20 items per run, and the report counts what is left', async () => {
  const s = await fresh();
  for (let i = 1; i <= 25; i++) await s.putEvent(dated(`ev${i}`, `Band ${i}`, `2026-06-${String(i).padStart(2, '0')}`));
  const first = (await runCanonBackfill(s))!;
  assert.equal(first.created, 20);
  assert.equal(first.remaining, 5);
  assert.equal((await s.listEditions(100)).length, 20);
  const second = (await runCanonBackfill(s))!;
  assert.equal(second.created, 5);
  assert.equal(second.remaining, 0);
  assert.equal((await s.listEditions(100)).length, 25);
});

test('the Worker budget shortens the batch', async () => {
  const s = await fresh();
  for (let i = 1; i <= 5; i++) await s.putEvent(dated(`ev${i}`, `Band ${i}`, `2026-06-0${i}`));
  const r = (await runCanonBackfill(s, { budgetLeft: () => 17 + 20 * 2 }))!;
  assert.equal(r.created, 2);
  assert.equal(r.remaining, 3);
  assert.equal(await runCanonBackfill(s, { budgetLeft: () => 10 }), null);
});

test('events without a full date are skipped and never get an edition', async () => {
  const s = await fresh();
  await s.putEvent(event('ev1', { name: 'Band A', year: 2026 }));
  await s.putEvent(event('ev2', { name: 'Band B', year: 2026, month: 5 }));
  const r = (await runCanonBackfill(s))!;
  assert.equal(r.skipped_no_date, 2);
  assert.equal(r.created, 0);
  assert.equal((await s.listEditions(10)).length, 0);
});

test('no personal field reaches an edition, a change record or a review row', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01', {
    companions: ['Zed Companion'], notes: 'secret-note', rating: 5, ticketPrice: 99, attendance: undefined,
  }));
  await runCanonBackfill(s);
  const [e] = await s.listEditions(10);
  const blob = JSON.stringify([e, await s.listEditionChanges(e.id), await s.listReviewItems()]);
  for (const bad of ['Zed Companion', 'secret-note', 'companions', 'rating', 'ticketPrice', 'notes', 'attendance']) {
    assert.ok(!blob.includes(bad), `${bad} leaked`);
  }
});

test('added email imports become verified editions from the email facts; other statuses are ignored', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Typed Name', '2026-06-01', { notes: 'personal' }));
  await s.putEvent(dated('ev2', 'Other Show', '2026-07-01'));
  await s.putImports([
    imp('i1', 'ev1', { name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', city: 'Austin', ticketPrice: 40, tickets: 2 }),
    imp('i2', 'ev2', { status: 'new', name: 'Not Ticked' }),
  ]);
  const r = (await runCanonBackfill(s))!;
  // ev1 is handled once through its import; ev2 is a plain dated event.
  assert.equal(r.created, 2);
  const names = (await s.listEditions(10)).map((e) => e.name).sort();
  assert.deepEqual(names, ['Band A', 'Other Show']);
  const all = await s.listEditions(10);
  assert.ok(all.every((e) => e.status === 'verified'));
  assert.ok(!JSON.stringify(all).includes('ticketPrice'));
});

test('an import whose event was deleted, or that has no date, creates nothing', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01'));
  await s.putImports([imp('i1', 'ev1', { name: 'Band A' }), imp('i2', 'gone', { name: 'Band Z', startDate: '2026-08-01' })]);
  const r = (await runCanonBackfill(s))!;
  assert.equal(r.skipped_no_date, 1);
  assert.equal(r.skipped_other, 1);
  assert.equal(r.created, 1); // ev1 falls back to the event itself, since its import had no date
});

test('a matching provisional edition is promoted to verified', async () => {
  const s = await fresh();
  await runCanonBackfill(s); // empty store: completes
  await s.putSetting('canon_backfill', { done: [] });
  const venue = await s.upsertVenue({ name: 'The Hall', city: 'Austin' });
  await writeEdition(s, { edition: edition({ status: 'provisional', venueId: venue.id, subjectKey: 'band-a', venue: 'The Hall', city: 'Austin' }), actor: 't', reason: 't' });
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01'));
  const r = (await runCanonBackfill(s))!;
  assert.equal(r.promoted, 1);
  assert.equal(r.matched, 1);
  assert.equal(r.created, 0);
  assert.equal((await s.listEditions(10))[0].status, 'verified');
});

test('existing editions get venue_id and subject_key where missing, nothing invented', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: edition({ id: 'a', key: 'k1', venue: 'The Hall', city: 'Austin' }), actor: 't', reason: 't' });
  await writeEdition(s, { edition: edition({ id: 'b', key: 'k2', seriesSlug: 'fest', name: 'Fest', startDate: undefined }), actor: 't', reason: 't' });
  await writeEdition(s, { edition: edition({ id: 'c', key: 'k3', status: 'draft' }), actor: 't', reason: 't' });
  const r = (await runCanonBackfill(s))!;
  assert.equal(r.venue_set, 1);
  assert.equal(r.subject_set, 2);
  const by = Object.fromEntries((await s.listEditions(10)).map((e) => [e.id, e]));
  assert.ok(by.a.venueId);
  assert.equal(by.a.subjectKey, 'band-a');
  assert.equal(by.b.venueId, undefined); // no venue text, no venue
  assert.equal(by.b.subjectKey, 'fest');
  assert.equal(by.c.subjectKey, undefined); // drafts are the owner's own and untouched
  assert.equal((await s.listEditionChanges('a')).length, 2);
});

test('missed events and events already linked to an edition are not backfilled', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01', { attendance: 'missed' }));
  await s.putEvent(dated('ev2', 'Band B', '2026-06-02', { editionId: 'x' }));
  const r = (await runCanonBackfill(s))!;
  assert.equal(r.skipped_other, 2);
  assert.equal((await s.listEditions(10)).length, 0);
});

test('only the owner scope is read: a member event is never turned into an edition', async () => {
  const base = await fresh();
  const owner = base.forUser({ userId: 'owner-1', role: 'owner' });
  const member = base.forUser({ userId: 'member-1', role: 'member' });
  await owner.putEvent(dated('ev-owner', 'Owner Show', '2026-06-01'));
  await member.putEvent(dated('ev-member', 'Member Show', '2026-06-02'));
  const r = (await runCanonBackfill(owner))!;
  assert.equal(r.created, 1);
  assert.deepEqual((await base.listEditions(10)).map((e) => e.name), ['Owner Show']);
});

test('a unique-index clash skips only that item and the run goes on', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01'));
  await s.putEvent(dated('ev2', 'Band B', '2026-06-02'));
  const wrapped = new Proxy(s, {
    get(t, p) {
      if (p === 'getEdition') return async (id: string) => t.getEdition(id);
      const v = Reflect.get(t, p, t);
      if (p === 'upsertEdition') {
        return async (e: Edition) => {
          if (e.name === 'Band A') throw new EditionOccurrenceConflictError(e.id);
          return (v as any).call(t, e);
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const r = (await runCanonBackfill(wrapped))!;
  assert.equal(r.skipped_other, 1);
  assert.equal(r.created, 1);
  assert.equal(r.remaining, 0);
  assert.deepEqual((await s.listEditions(10)).map((e) => e.name), ['Band B']);
});

// Supabase row mapping for venue_id, subject_key and has_lineup, and the unique-index error.
function writeDb(upsertError: any) {
  const rows: any[] = [];
  const db = {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, order: () => b, range: () => b, maybeSingle: () => b,
        upsert: (row: any) => {
          if (table === 'event_editions') rows.push(row);
          return Promise.resolve({ data: null, error: table === 'event_editions' ? upsertError : null });
        },
        delete: () => b,
        insert: () => Promise.resolve({ data: null, error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: table === 'event_editions' ? rows : [], error: null }).then(res, rej),
      };
      return b;
    },
  };
  return { db, rows };
}

test('Supabase upsertEdition writes venue_id, subject_key and has_lineup (null when unset)', async () => {
  const { db, rows } = writeDb(null);
  const store = new SupabaseLineupStore(db as any);
  await store.upsertEdition(edition({ venueId: 'v1', subjectKey: 'band-a', hasLineup: false }));
  await store.upsertEdition(edition({ id: 'e2' }));
  assert.deepEqual([rows[0].venue_id, rows[0].subject_key, rows[0].has_lineup], ['v1', 'band-a', false]);
  assert.deepEqual([rows[1].venue_id, rows[1].subject_key, rows[1].has_lineup], [null, null, null]);
});

test('Supabase upsertEdition turns an occurrence unique violation into EditionOccurrenceConflictError', async () => {
  const { db } = writeDb({ code: '23505', message: 'duplicate key value violates unique constraint "event_editions_occurrence_uidx"' });
  const store = new SupabaseLineupStore(db as any);
  await assert.rejects(store.upsertEdition(edition({ venueId: 'v1', subjectKey: 'band-a' })), EditionOccurrenceConflictError);
});

test('Supabase rows read back venueId, subjectKey and hasLineup, omitted when null', async () => {
  const row = (extra: any) => ({ id: 'e', key: 'k', series_slug: 's', year: 2026, name: 'N', status: 'verified', updated_at: 'x', ...extra });
  const { db } = writeDb(null);
  const store = new SupabaseLineupStore(db as any) as any;
  const a = store.toEdition(row({ venue_id: 'v1', subject_key: 'sk', has_lineup: true }), []);
  assert.deepEqual([a.venueId, a.subjectKey, a.hasLineup], ['v1', 'sk', true]);
  const b = store.toEdition(row({ venue_id: null, subject_key: null, has_lineup: null }), []);
  assert.ok(!('venueId' in b) && !('subjectKey' in b) && !('hasLineup' in b));
});

test('budget depletion inside the loop stops early and leaves cursor incomplete', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01'));
  await s.putEvent(dated('ev2', 'Band B', '2026-06-02'));
  let calls = 0;
  const budgetLeft = () => {
    calls++;
    return calls <= 2 ? 60 : 10;
  };
  const r = (await runCanonBackfill(s, { budgetLeft }))!;
  assert.equal(r.created, 1);
  assert.equal(r.remaining, 1);
  const cursor = (await s.getSetting<any>('canon_backfill'))!;
  assert.equal(cursor.complete, undefined);
  assert.deepEqual(cursor.done, ['event:ev1']);
});

test('writeEdition with input.before skips upsertEdition when no fields changed', async () => {
  const s = await fresh();
  let upsertCalled = false;
  const originalUpsert = s.upsertEdition.bind(s);
  s.upsertEdition = async (e) => {
    upsertCalled = true;
    return originalUpsert(e);
  };
  const base = edition({ id: 'e1', name: 'Band A' });
  await writeEdition(s, { edition: base, actor: 't', reason: 'init' });
  assert.equal(upsertCalled, true);

  upsertCalled = false;
  const same = { ...base, updatedAt: '2027-01-01T00:00:00.000Z' };
  const res = await writeEdition(s, { edition: same, before: base, actor: 't', reason: 'noop' });
  assert.equal(res.changed, false);
  assert.equal(upsertCalled, false);
});

test('runCanonBackfill calls listEditionHeaders instead of listEditions when listEditionHeaders is available', async () => {
  const s = await fresh();
  let listHeadersCalled = false;
  let listEditionsCalled = false;
  const origListHeaders = s.listEditionHeaders.bind(s);
  const origListEditions = s.listEditions.bind(s);
  s.listEditionHeaders = async (opts) => {
    listHeadersCalled = true;
    return origListHeaders(opts);
  };
  s.listEditions = async (limit) => {
    listEditionsCalled = true;
    return origListEditions(limit);
  };
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01'));
  const r = await runCanonBackfill(s);
  assert.ok(r);
  assert.equal(listHeadersCalled, true);
  assert.equal(listEditionsCalled, false);
});

test('cachedEditions caches listEditionHeaders across multiple items in the same run', async () => {
  const s = await fresh();
  await s.putEvent(dated('ev1', 'Band A', '2026-06-01'));
  await s.putEvent(dated('ev2', 'Band B', '2026-06-02'));
  let listHeadersCalls = 0;
  const origListHeaders = s.listEditionHeaders.bind(s);
  s.listEditionHeaders = async (opts) => {
    listHeadersCalls++;
    return origListHeaders(opts);
  };
  const r = await runCanonBackfill(s);
  assert.ok(r);
  assert.equal(r.created, 2);
  assert.equal(listHeadersCalls, 1);
});

test('fillEdition hydrates the full edition via getEdition and preserves existing performances when updating venueId / subjectKey', async () => {
  const s = await fresh();
  const samplePerf = {
    artistKey: 'artist-1',
    name: 'Artist 1',
    days: ['2026-06-01'],
    stages: ['Main Stage'],
    status: 'billed' as const,
    confidence: 1,
    sources: [],
  };
  await writeEdition(s, {
    edition: edition({
      id: 'e-perf',
      key: 'fest/2026',
      name: 'Fest With Perfs',
      seriesSlug: 'fest',
      venue: 'The Hall',
      city: 'Austin',
      performances: [samplePerf],
    }),
    actor: 'test',
    reason: 'setup',
  });

  let getEditionCalledForEPerf = false;
  const origGetEdition = s.getEdition.bind(s);
  s.getEdition = async (id: string) => {
    if (id === 'e-perf') getEditionCalledForEPerf = true;
    return origGetEdition(id);
  };

  const r = await runCanonBackfill(s);
  assert.ok(r);
  assert.equal(r.venue_set, 1);
  assert.equal(r.subject_set, 1);
  assert.equal(getEditionCalledForEPerf, true);

  const updated = await s.getEdition('e-perf');
  assert.ok(updated);
  assert.ok(updated.venueId);
  assert.equal(updated.subjectKey, 'fest');
  assert.equal(updated.performances.length, 1);
  assert.deepEqual(updated.performances[0], samplePerf);
});
