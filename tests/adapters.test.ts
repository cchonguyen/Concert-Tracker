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
  assert.equal(belongsToEvent({ venue: { name: 'Las Vegas Motor Speedway' } }, 'EDC', 'Las Vegas Motor Speedway'), true);
  assert.equal(belongsToEvent({ venue: { name: 'Omnia' } }, 'EDC Las Vegas', 'Las Vegas Motor Speedway'), false);
  assert.equal(belongsToEvent({ tour: { name: 'EDC Las Vegas 2025' }, venue: { name: 'LVMS' } }, 'EDC Las Vegas'), true);
});
