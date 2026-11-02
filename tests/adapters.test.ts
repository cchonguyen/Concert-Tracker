import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clashfinderAdapter,
  festivalDay,
  matchEdition,
  parseEventData,
  parseEventList,
  slugFromClashfinderUrl,
} from '../src/server/lineup/adapters/clashfinder.ts';
import { promoterAdapter, rawSnapshotUrl, snapshotInWindow } from '../src/server/lineup/adapters/promoter.ts';
import { matchingEvents, ticketmasterAdapter } from '../src/server/lineup/adapters/ticketmaster.ts';
import { belongsToEvent, toSetlistDate } from '../src/server/lineup/adapters/setlistfm.ts';
import { fakeFetcher } from './fakes.ts';
import { braveSearch, isEventDomain, pageMentionsEvent, searchQuery } from '../src/server/lineup/search.ts';
import { QuotaExhaustedError } from '../src/server/lineup/quota.ts';
import { Fetcher } from '../src/server/lineup/types.ts';

test('clashfinder: slugs from URLs, edition matching and late-night sets', () => {
  assert.equal(slugFromClashfinderUrl('https://clashfinder.com/s/edc2025/'), 'edc2025');
  assert.equal(slugFromClashfinderUrl('https://clashfinder.com/m/edc2025/?user=x'), 'edc2025');
  const list = parseEventList({
    edc2024: { name: 'EDC Las Vegas 2024' },
    edc2025: { name: 'EDC Las Vegas 2025' },
    edcorl25: { name: 'EDC Orlando 2025' },
  });
  assert.equal(matchEdition(list, 'EDC Las Vegas', 2025)?.slug, 'edc2025');
  assert.equal(matchEdition(list, 'Coachella', 2025), null);
  assert.equal(festivalDay('2025-05-17 02:30'), '2025-05-16');
  assert.equal(festivalDay('2025-05-16 21:00'), '2025-05-16');
});

test('clashfinder: real list format (title in desc, Unix dates, duplicate slugs)', () => {
  const may15 = 1778803200; // 2026-05-15
  const list = parseEventList({
    edc2026: { name: 'edc2026', desc: 'EDC Las Vegas 2026', startDate: may15, edits: 40, numActs: 300, private: 0 },
    edclv2026: { name: 'edclv2026', desc: 'EDC Las Vegas 2026', startDate: may15, edits: 900, numActs: 310, private: 0 },
    edclv2026livestream: { name: 'edclv2026livestream', desc: 'EDC Las Vegas 2026 Livestream', startDate: may15, edits: 12, numActs: 80 },
    edcvegas2026: { name: 'edcvegas2026', desc: 'EDC 2026 (Fantasy)', startDate: may15, edits: 5000, numActs: 200 },
    edclasvegas2026: { name: 'edclasvegas2026', desc: 'EDC LV 2026', startDate: may15, edits: 3000, numActs: 250, private: 1 },
    edcmx26: { name: 'edcmx26', desc: 'EDC Mexico 2026', startDate: 1771545600, edits: 50, numActs: 120 },
    edc2025: { name: 'edc2025', desc: 'EDC Las Vegas 2025', startDate: 1747353600, edits: 800, numActs: 300 },
  });
  assert.equal(list.find((e) => e.slug === 'edc2026')?.startDate, '2026-05-15');
  // Most-edited public, non-fantasy clash for the year wins.
  assert.equal(matchEdition(list, 'EDC 2026', 2026)?.slug, 'edclv2026');
  assert.equal(matchEdition(list, 'EDC Las Vegas', 2026)?.slug, 'edclv2026');
  assert.equal(matchEdition(list, 'EDC Mexico', 2026)?.slug, 'edcmx26');
  assert.equal(matchEdition(list, 'EDC', 2025)?.slug, 'edc2025');
  assert.equal(matchEdition(list, 'EDC', 2024), null);
  // A slug run together from the name counts when the title spells it out.
  const spelled = parseEventList({ edc2026: { name: 'edc2026', desc: 'Electric Daisy Carnival 2026', startDate: may15, numActs: 5 } });
  assert.equal(matchEdition(spelled, 'EDC', 2026)?.slug, 'edc2026');
});

test('clashfinder: weekend date proximity and festival stop-words disambiguation', () => {
  const list = parseEventList({
    coachella2024w1: { name: 'coachella2024w1', desc: 'Coachella 2024 Weekend 1', startDate: '2024-04-12', edits: 900, numActs: 150 },
    coachella2024w2: { name: 'coachella2024w2', desc: 'Coachella 2024 Weekend 2', startDate: '2024-04-19', edits: 300, numActs: 150 },
    portola2023: { name: 'portola2023', desc: 'Portola 2023', startDate: '2023-09-30', edits: 50, numActs: 80 },
  });
  assert.equal(matchEdition(list, 'Coachella', 2024, '2024-04-19')?.slug, 'coachella2024w2');
  assert.equal(matchEdition(list, 'Coachella Weekend 2', 2024)?.slug, 'coachella2024w2');
  assert.equal(matchEdition(list, 'Portola Music Festival', 2023)?.slug, 'portola2023');
});

test('clashfinder: parses acts with stage and day', async () => {
  process.env.CLASHFINDER_USERNAME = 'me';
  process.env.CLASHFINDER_PUBLIC_KEY = 'k';
  const data = {
    name: 'EDC Las Vegas 2025',
    locations: [
      { name: 'kineticFIELD', events: [{ name: 'Kaskade', start: '2025-05-16 23:00', end: '2025-05-17 00:30' }] },
      { name: 'circuitGROUNDS', events: [{ name: 'Eric Prydz', start: '2025-05-17 03:00', end: '2025-05-17 04:30' }] },
    ],
  };
  assert.equal(parseEventData(data).acts.length, 2);
  const { fetcher, calls } = fakeFetcher({ 'https://clashfinder.com/data/event/edc2025.json': { body: data } });
  const result = await clashfinderAdapter.collect({
    input: { eventName: 'EDC Las Vegas', year: 2025, lineupUrl: 'https://clashfinder.com/s/edc2025/' },
    editionKey: 'edc-las-vegas/2025',
    series: null,
    now: new Date('2025-06-01'),
    fetcher,
  });
  assert.match(calls[0], /authUsername=me&authPublicKey=k/);
  assert.deepEqual(result.performers.map((p) => [p.name, p.day, p.stage]), [
    ['Kaskade', '2025-05-16', 'kineticFIELD'],
    ['Eric Prydz', '2025-05-16', 'circuitGROUNDS'],
  ]);
  assert.equal(result.facts.startDate?.[0].value, '2025-05-16');
  assert.deepEqual(result.seriesHints?.clashfinderSlugs, { '2025': 'edc2025' });
});

test('promoter: past events read the Wayback snapshot, not the live page', async () => {
  assert.equal(
    rawSnapshotUrl('http://web.archive.org/web/20250510120000/https://x.com/lineup'),
    'http://web.archive.org/web/20250510120000id_/https://x.com/lineup',
  );
  assert.equal(snapshotInWindow('20250510120000', '2025-05-16', '2025-05-18'), true);
  assert.equal(snapshotInWindow('20230101000000', '2025-05-16', '2025-05-18'), false);

  const { fetcher, calls } = fakeFetcher({
    'https://archive.org/wayback/available': {
      body: { archived_snapshots: { closest: { available: true, timestamp: '20250515000000', url: 'http://web.archive.org/web/20250515000000/https://edc.example/lineup' } } },
    },
    'http://web.archive.org/web/20250515000000id_/': { body: '<h1>Lineup</h1><li>Kaskade</li>' },
    'https://edc.example/lineup': { body: '<li>Next Year Act</li>' },
  });
  const result = await promoterAdapter.collect({
    input: { eventName: 'EDC', year: 2025, startDate: '2025-05-16', endDate: '2025-05-18', lineupUrl: 'https://edc.example/lineup' },
    editionKey: 'edc/2025',
    series: null,
    now: new Date('2025-10-01'),
    fetcher,
  });
  assert.equal(result.documents[0].sourceType, 'wayback');
  assert.match(result.documents[0].body, /Kaskade/);
  assert.equal(result.extractionQueue.length, 1);
  assert.ok(!calls.includes('https://edc.example/lineup'));
});

test('promoter: no URL known means no fetch', async () => {
  const { fetcher, calls } = fakeFetcher({});
  const result = await promoterAdapter.collect({
    input: { eventName: 'EDC', year: 2025 },
    editionKey: 'edc/2025',
    series: null,
    now: new Date(),
    fetcher,
  });
  assert.equal(calls.length, 0);
  assert.equal(result.documents.length, 0);
});

test('ticketmaster: only listings whose name matches the event', async () => {
  const events = [
    { id: '1', name: 'Portola Music Festival - Saturday', dates: { start: { localDate: '2025-09-27' } }, _embedded: { attractions: [{ id: 'a', name: 'Kaytranada' }] } },
    { id: '2', name: 'Random Club Night', dates: { start: { localDate: '2025-09-27' } } },
  ];
  assert.equal(matchingEvents(events as any, 'Portola Music Festival 2025').length, 1);
  process.env.TICKETMASTER_API_KEY = 'tm';
  const { fetcher } = fakeFetcher({ 'https://app.ticketmaster.com/': { body: { _embedded: { events } } } });
  const result = await ticketmasterAdapter.collect({
    input: { eventName: 'Portola Music Festival', year: 2025 },
    editionKey: 'portola-music-festival/2025',
    series: null,
    now: new Date(),
    fetcher,
  });
  assert.deepEqual(result.performers.map((p) => p.name), ['Kaytranada']);
  assert.equal(result.facts.startDate?.[0].value, '2025-09-27');
});

test('setlist.fm: date format and event matching', () => {
  assert.equal(toSetlistDate('2025-05-16'), '16-05-2025');
  assert.equal(belongsToEvent({ tour: { name: 'EDC' }, venue: { name: 'Las Vegas Motor Speedway' } }, 'EDC', 'Las Vegas Motor Speedway'), true);
  assert.equal(belongsToEvent({ venue: { name: 'Las Vegas Motor Speedway' } }, 'EDC', 'Las Vegas Motor Speedway'), false);
  assert.equal(belongsToEvent({ venue: { name: 'Omnia' } }, 'EDC Las Vegas', 'Las Vegas Motor Speedway'), false);
  assert.equal(belongsToEvent({ tour: { name: 'EDC Las Vegas 2025' }, venue: { name: 'LVMS' } }, 'EDC Las Vegas'), true);
});

test('search: Brave query, results and quota parking', async () => {
  const input = { eventName: 'Zedd in the Park 2026', year: 2026 };
  assert.equal(searchQuery(input), '"Zedd in the Park" 2026 lineup');
  assert.ok(pageMentionsEvent('Zedd In The Park — 2026 lineup announced', input));
  assert.ok(!pageMentionsEvent('Zedd in the Park 2025', input));
  assert.ok(!pageMentionsEvent('Zedd tour 2026', input));

  const { fetcher, calls } = fakeFetcher({
    'https://api.search.brave.com/': { body: { web: { results: [{ url: 'https://a.example/x' }, { url: 'https://a.example/x' }, { url: 'https://b.example/y' }] } } },
  });
  assert.deepEqual(await braveSearch(fetcher, 'k').findLineupUrls(input), ['https://a.example/x', 'https://b.example/y']);
  assert.ok(calls[0].includes('q=%22Zedd%20in%20the%20Park%22%202026%20lineup'));

  const limited: Fetcher = {
    async get(url) {
      return { url, status: 429, headers: { 'x-ratelimit-reset': '1, 86400' }, body: '' };
    },
  };
  const now = new Date('2026-10-20T00:00:00Z');
  await assert.rejects(braveSearch(limited, 'k', () => now).findLineupUrls(input), (err: unknown) => {
    assert.ok(err instanceof QuotaExhaustedError);
    assert.equal(err.retryAt.toISOString(), '2026-10-21T00:00:01.000Z');
    return true;
  });
});

test('search: a result on the event domain is the organiser page', () => {
  assert.ok(isEventDomain('https://sunsoaked.insomniac.com/lineup/', 'Sun Soaked 2026'));
  assert.ok(isEventDomain('https://www.zeddinthepark.com/', 'Zedd in the Park'));
  assert.ok(!isEventDomain('https://www.jambase.com/festival/zedd-in-the-park-2026', 'Zedd in the Park'));
  assert.ok(!isEventDomain('https://edc.example.com/', 'EDC')); // too short to tell
});
