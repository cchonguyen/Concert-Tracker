import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { billingFromTitle, splitBill } from '../src/server/lineup/billing.ts';
import { ticketmasterAdapter } from '../src/server/lineup/adapters/ticketmaster.ts';
import { mergeLineup } from '../src/server/lineup/merge.ts';
import { confirmLookup } from '../src/server/lineup/learning.ts';
import { createLookup, PipelineDeps, runJob } from '../src/server/lineup/pipeline.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { QuotaLedger } from '../src/server/lineup/quota.ts';
import { PerformerClaim, SourceAdapter } from '../src/server/lineup/types.ts';
import { applyPatch, newEvent, startLineupLookup } from '../src/server/events/service.ts';
import { artistSuggestions } from '../src/server/events/artists.ts';
import { eventScale, lineupFacts } from '../src/server/events/scale.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { EMPTY_FILTERS, filterEvents, filtersFromQuery, filtersToQuery } from '../src/services/table.ts';
import { eventsToCsv } from '../src/services/format.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const ev = (line: string, extra: Partial<LoggedEvent> = {}): LoggedEvent => ({ ...newEvent(line, NOW), ...extra });

test('billing: a marker with a billed act on each side gives headliner and support', () => {
  assert.equal(splitBill('Porter Robinson with special guest Wavedash')?.head, 'Porter Robinson');
  assert.equal(splitBill('Porter Robinson with special guest Wavedash')?.tail, 'Wavedash');
  const roles = billingFromTitle('Porter Robinson with special guest Wavedash', ['Porter Robinson', 'Wavedash']);
  assert.equal(roles.get('porter robinson'), 'headliner');
  assert.equal(roles.get('wavedash'), 'support');
  const w = billingFromTitle('ODESZA w/ Sylvan Esso, Big Wild', ['ODESZA', 'Sylvan Esso', 'Big Wild']);
  assert.deepEqual([...w.entries()].sort(), [['big wild', 'support'], ['odesza', 'headliner'], ['sylvan esso', 'support']]);
  assert.equal(billingFromTitle('Above & Beyond supported by Spencer Brown', ['Above & Beyond', 'Spencer Brown']).get('above and beyond'), 'headliner');
});

test('billing: no marker, or nobody before it, gives no role', () => {
  assert.equal(billingFromTitle('Fred again.. & Four Tet', ['Fred again..', 'Four Tet']).size, 0);
  assert.equal(billingFromTitle('An Evening with Bonobo', ['Bonobo']).size, 0);
  assert.equal(billingFromTitle('EDC Las Vegas 2025', ['Kaskade', 'Tiesto']).size, 0);
  // Only one side names a billed act.
  assert.equal(billingFromTitle('Porter Robinson with special guests', ['Porter Robinson']).size, 0);
});

test('ticketmaster: a "with" listing bills its attractions, quoting the listing name', async () => {
  process.env.TICKETMASTER_API_KEY = 'tm';
  const events = [
    {
      id: '1',
      name: 'Porter Robinson with special guest Wavedash',
      dates: { start: { localDate: '2024-10-05' } },
      _embedded: { attractions: [{ id: 'a', name: 'Porter Robinson' }, { id: 'b', name: 'Wavedash' }] },
    },
  ];
  const { fetcher } = fakeFetcher({ 'https://app.ticketmaster.com/': { body: { _embedded: { events } } } });
  const result = await ticketmasterAdapter.collect({
    input: { eventName: 'Porter Robinson', year: 2024, startDate: '2024-10-05' },
    editionKey: 'porter-robinson/2024-10-05',
    series: null,
    now: NOW,
    fetcher,
  });
  const byName = Object.fromEntries(result.performers.map((p) => [p.name, p]));
  assert.equal(byName['Porter Robinson'].billing, 'headliner');
  assert.equal(byName['Wavedash'].billing, 'support');
  assert.equal(byName['Wavedash'].quotedSpan, 'Porter Robinson with special guest Wavedash');
});

const claim = (name: string, billing?: PerformerClaim['billing'], sourceUrl = 'https://tm.example/1'): PerformerClaim => ({
  id: `${name}-${sourceUrl}`,
  jobId: 'j',
  documentId: 'd',
  sourceType: 'ticketmaster',
  sourceUrl,
  name,
  quotedSpan: name,
  evidence: 'billed',
  billing,
  extractor: 'ticketmaster',
  extractorVersion: 'test',
  createdAt: NOW.toISOString(),
});

test('merge: a role only when every source that states one agrees', () => {
  const lineup = mergeLineup({
    input: { eventName: 'Show', year: 2024 },
    editionKey: 'show/2024',
    seriesSlug: 'show',
    facts: {},
    claims: [
      claim('Lead', 'headliner'),
      claim('Lead', undefined, 'https://tm.example/2'),
      claim('Opener', 'support'),
      claim('Torn', 'support'),
      claim('Torn', 'headliner', 'https://tm.example/2'),
    ],
    aliases: {},
    blocklist: [],
    stats: [],
  });
  const role = (n: string) => lineup.performers.find((p) => p.name === n)?.billing;
  assert.equal(role('Lead'), 'headliner');
  assert.equal(role('Opener'), 'support');
  assert.equal(role('Torn'), undefined);
});

test('confirm: roles reach the lineup and your seen acts; your change is yours', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'roles-')));
  const listing: SourceAdapter = {
    id: 'ticketmaster',
    enabled: () => true,
    async collect() {
      const doc = makeDocument('https://tm.example/1', 'ticketmaster', '{}', 'json');
      return {
        documents: [doc],
        performers: [claim('Porter Robinson', 'headliner'), claim('Wavedash', 'support'), claim('Jai Wolf', 'support')].map(
          ({ id, jobId, createdAt, ...c }) => ({ ...c, documentId: doc.id }),
        ),
        facts: {},
        extractionQueue: [],
        notes: [],
      };
    },
  };
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [listing],
    lateAdapters: [],
    gemini: null,
    quota: new QuotaLedger(store, { provider: 'gemini', model: 'x', dailyLimit: 1, perMinute: 1 }),
    search: null,
    now: () => NOW,
  };
  const logged = ev('Porter Robinson at the Greek Theatre, Oct 5 2024');
  await store.putEvent(logged);
  const started = await startLineupLookup(deps, logged);
  const job = (await runJob(deps, started.job.id))!;
  const key = (n: string) => job.candidate!.performers.find((p) => p.name === n)!.key;
  const result = await confirmLookup(store, job, {
    performers: [
      { key: key('Porter Robinson'), name: 'Porter Robinson', accepted: true, seen: true },
      { key: key('Wavedash'), name: 'Wavedash', accepted: true, seen: true, billing: 'support' },
      { key: key('Jai Wolf'), name: 'Jai Wolf', accepted: true, seen: true, billing: null },
    ],
  });
  const perf = (n: string) => result.edition.performances.find((p) => p.name === n)!;
  assert.equal(perf('Porter Robinson').billing, 'headliner');
  assert.equal(perf('Wavedash').billing, 'support');
  assert.equal(perf('Jai Wolf').billing, undefined);
  const seen = Object.fromEntries(result.event!.seen.map((s) => [s.name, s]));
  assert.deepEqual([seen['Porter Robinson'].role, seen['Porter Robinson'].roleFrom], ['headliner', 'lineup']);
  assert.deepEqual([seen['Wavedash'].role, seen['Wavedash'].roleFrom], ['support', 'lineup']);
  assert.equal(seen['Jai Wolf'].role, undefined);
  // The edition is reused with its roles.
  const again = await createLookup(deps, { eventName: 'Porter Robinson', year: 2024, startDate: '2024-10-05' });
  assert.equal(again.candidate?.performers.find((p) => p.name === 'Wavedash')?.billing, 'support');
});

test('seen acts keep a valid role you set; the type takes concert, festival or null', () => {
  const e = ev('Show 2024');
  const next = applyPatch(
    e,
    { seen: [{ name: 'A', role: 'support' }, { name: 'B', role: 'bogus' as any }, { name: 'C', role: null }], kind: 'festival' },
    NOW,
  );
  assert.deepEqual(
    next.seen.map((s) => [s.name, s.role, s.roleFrom]),
    [
      ['A', 'support', 'you'],
      ['B', undefined, undefined],
      ['C', undefined, undefined],
    ],
  );
  assert.equal(next.kind, 'festival');
  assert.equal(applyPatch(next, { kind: null }, NOW).kind, undefined);
  assert.throws(() => applyPatch(e, { kind: 'rave' as any }, NOW));
});

test('scale: your choice, then days, acts, Clashfinder; concert only from a known small lineup', () => {
  assert.equal(eventScale(ev('EDC Las Vegas', { startDate: '2025-05-16', endDate: '2025-05-18' })).reason, '3 days');
  assert.equal(eventScale(ev('EDC Las Vegas', { startDate: '2025-05-16', endDate: '2025-05-18', kind: 'concert' })).kind, 'concert');
  const show = ev('Porter Robinson', { startDate: '2024-10-05' });
  assert.equal(eventScale(show).kind, undefined);
  assert.equal(eventScale(show).reason, 'Not known yet');
  assert.equal(eventScale(show, { acts: 2, clashfinder: false }).kind, 'concert');
  assert.equal(eventScale(show, { acts: 6, clashfinder: false }).kind, 'festival');
  assert.equal(eventScale(show, { acts: 3, clashfinder: true }).kind, 'festival');
  // Seen acts count as known acts; five is still not enough to say concert.
  const seen = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `a${i}`, name: `A${i}`, from: 'you' as const }));
  assert.equal(eventScale({ ...show, seen: seen(6) }).kind, 'festival');
  assert.equal(eventScale({ ...show, seen: seen(5) }).kind, undefined);
  // Stage 1 matched the date to a Clashfinder edition.
  const cf = {
    ...show,
    details: {
      status: 'matched' as const,
      notes: [],
      candidates: [{ id: 'c', startDate: '2024-10-05', sources: [{ sourceType: 'clashfinder' as const, sourceUrl: 'u', fields: ['startDate' as const] }] }],
    },
  };
  assert.equal(eventScale(cf).kind, 'festival');
  const facts = lineupFacts({
    performances: [
      { artistKey: 'a', name: 'A', days: [], stages: [], status: 'billed', confidence: 1, sources: [] },
      { artistKey: 'b', name: 'B', days: [], stages: [], status: 'cancelled', confidence: 1, sources: [] },
    ],
  });
  assert.deepEqual(facts, { acts: 1, clashfinder: false });
});

test('suggestions: acts named in the event name, only when a source lists them', () => {
  const performers = [
    { name: 'Porter Robinson', sourceType: 'ticketmaster' as const, sourceUrl: 'u' },
    { name: 'Wavedash', sourceType: 'ticketmaster' as const, sourceUrl: 'u' },
    { name: 'Someone Else', sourceType: 'ticketmaster' as const, sourceUrl: 'u' },
  ];
  const withGuest = ev('Porter Robinson with special guest Wavedash 2024');
  assert.deepEqual(
    artistSuggestions(withGuest, performers).map((s) => [s.name, s.role]),
    [
      ['Porter Robinson', 'headliner'],
      ['Wavedash', 'support'],
    ],
  );
  // A plain name: Artist, no role stated.
  assert.deepEqual(artistSuggestions(ev('Porter Robinson 2024'), performers).map((s) => [s.name, s.role]), [['Porter Robinson', undefined]]);
  // Nothing confirms it: nothing offered.
  assert.deepEqual(artistSuggestions(ev('Porter Robinson 2024'), []), []);
  // Already seen: not offered again, but still counts for the other act's role.
  const seenLead = { ...withGuest, seen: [{ key: 'porter robinson', name: 'Porter Robinson', from: 'you' as const }] };
  assert.deepEqual(artistSuggestions(seenLead, performers).map((s) => [s.name, s.role]), [['Wavedash', 'support']]);
});

test('table and CSV: type filter in the address, Artist and Supporting columns', () => {
  const fest = ev('EDC Las Vegas', { startDate: '2025-05-16', endDate: '2025-05-18' });
  const show = ev('Porter Robinson', {
    startDate: '2024-10-05',
    editionId: 'e1',
    seen: [
      { key: 'porter robinson', name: 'Porter Robinson', from: 'lineup', role: 'headliner', roleFrom: 'lineup' },
      { key: 'wavedash', name: 'Wavedash', from: 'lineup', role: 'support', roleFrom: 'lineup' },
    ],
  });
  const unknown = ev('Warehouse thing', { startDate: '2023-01-01' });
  const editions = { [show.id]: { acts: 2, clashfinder: false } };
  const all = [fest, show, unknown];
  const names = (kind: 'concert' | 'festival' | 'unknown') =>
    filterEvents(all, { ...EMPTY_FILTERS, kind }, {}, editions).map((e) => e.name);
  assert.deepEqual(names('festival'), ['EDC Las Vegas']);
  assert.deepEqual(names('concert'), ['Porter Robinson']);
  assert.deepEqual(names('unknown'), ['Warehouse thing']);
  assert.equal(filtersFromQuery(filtersToQuery({ ...EMPTY_FILTERS, kind: 'festival' })).kind, 'festival');

  const [header, row] = eventsToCsv([show], editions).split('\n');
  const cols = header.split(',');
  const cells = row.split(',');
  assert.equal(cells[cols.indexOf('Type')], 'Concert');
  assert.equal(cells[cols.indexOf('Artist')], 'Porter Robinson');
  assert.equal(cells[cols.indexOf('Supporting artists')], 'Wavedash');
});
