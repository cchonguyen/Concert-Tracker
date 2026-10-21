import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { quoteBacksBilling } from '../src/server/lineup/billing.ts';
import { artistSuggestions, nameArtistSuggestions, pastArtists, titleParts } from '../src/server/events/artists.ts';
import { applyPatch, newEvent, startBulkLookups } from '../src/server/events/service.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { QuotaLedger } from '../src/server/lineup/quota.ts';
import { canFindLineup, EMPTY_FILTERS, filterEvents, filtersFromQuery, filtersToQuery, gapCounts, hasGap } from '../src/services/table.ts';
import { eventsToCsv } from '../src/services/format.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const ev = (line: string, extra: Partial<LoggedEvent> = {}): LoggedEvent => ({ ...newEvent(line, NOW), ...extra });

test('a page role counts only when its own words say so', () => {
  assert.ok(quoteBacksBilling('Headliners: Kaskade, Zedd', 'Zedd', 'headliner'));
  assert.ok(quoteBacksBilling('Headliners: Kaskade Support: Lane 8', 'Lane 8', 'support'));
  assert.equal(quoteBacksBilling('Headliners: Kaskade Support: Lane 8', 'Lane 8', 'headliner'), false);
  assert.ok(quoteBacksBilling('Porter Robinson with special guest Wavedash', 'Wavedash', 'support'));
  assert.ok(quoteBacksBilling('ODESZA w/ Sylvan Esso', 'ODESZA', 'headliner'));
  assert.equal(quoteBacksBilling('Kaskade, Zedd, Lane 8', 'Kaskade', 'headliner'), false); // order is not billing
  assert.equal(quoteBacksBilling('Headliners: Kaskade', 'Zedd', 'headliner'), false); // name not in the quote
});

test('title parts: subtitle and year go, markers and commas split, "&" stays', () => {
  assert.deepEqual(titleParts('Porter Robinson: Nurture Live 2024'), ['Porter Robinson']);
  assert.deepEqual(titleParts('ODESZA with special guest Sylvan Esso, Big Wild'), ['ODESZA', 'Sylvan Esso', 'Big Wild']);
  assert.deepEqual(titleParts('Above & Beyond - Group Therapy 500'), ['Above & Beyond']);
  assert.deepEqual(titleParts('John Summit b2b Dom Dolla'), ['John Summit', 'Dom Dolla']);
});

test('suggestions: acts you saw elsewhere, named in this title', () => {
  const other = ev('Kaskade Redux 2023', { seen: [{ key: 'kaskade', name: 'Kaskade', from: 'you' }, { key: 'zed', name: 'Zed', from: 'you' }] });
  const now = ev('Kaskade at the Shrine 2025');
  const sugg = artistSuggestions(now, pastArtists([other, now], now));
  assert.deepEqual(sugg.map((s) => [s.name, s.sourceType]), [['Kaskade', 'user']]);
});

test('suggestions: parts of the title MusicBrainz knows as artists', async () => {
  const { fetcher, calls } = fakeFetcher({
    'https://musicbrainz.org/ws/2/artist/?query=artist%3A%22Porter%20Robinson%22': {
      body: { artists: [{ id: 'mb1', name: 'Porter Robinson', score: 100 }] },
    },
    'https://musicbrainz.org/ws/2/artist/?query=artist%3A%22Nobody%20Here%22': { body: { artists: [{ id: 'x', name: 'Nobody', score: 60 }] } },
  });
  const e = ev('Porter Robinson with special guest Nobody Here 2024');
  const sugg = await nameArtistSuggestions(e, fetcher);
  assert.deepEqual(sugg.map((s) => [s.name, s.sourceType, s.sourceUrl]), [['Porter Robinson', 'musicbrainz', 'https://musicbrainz.org/artist/mb1']]);
  assert.equal(calls.length, 2);
});

test('format is yours, free text, and filters the Table', () => {
  const e = applyPatch(ev('Dirtybird Campout 2024'), { format: '  Warehouse party ' }, NOW);
  assert.equal(e.format, 'Warehouse party');
  assert.equal(applyPatch(e, { format: null }, NOW).format, undefined);
  const other = ev('Other 2024');
  assert.deepEqual(filterEvents([e, other], { ...EMPTY_FILTERS, format: 'Warehouse party' }).map((x) => x.name), ['Dirtybird Campout']);
  assert.equal(filtersFromQuery(filtersToQuery({ ...EMPTY_FILTERS, format: 'Block party' })).format, 'Block party');
  const [header, row] = eventsToCsv([e]).split('\n');
  assert.equal(row.split(',')[header.split(',').indexOf('Format')], 'Warehouse party');
});

test('gaps: counts per missing field, and who can start a lineup lookup', () => {
  const full = ev('A at Venue in City, ST, Oct 5 2024', {
    venue: 'Venue',
    city: 'City, ST',
    kind: 'concert',
    format: 'Club night',
    seen: [{ key: 'a', name: 'A', from: 'you' }],
    companions: ['B'],
    rating: 4,
    ticketPrice: 30,
  });
  const bare = ev('Something 2023');
  const counts = gapCounts([full, bare], { [bare.id]: { jobId: 'j', status: 'needs_review', actCount: 3 } });
  assert.equal(counts.date, 1);
  assert.equal(counts.venue, 1);
  assert.equal(counts.rating, 1);
  assert.equal(counts.review, 1);
  assert.equal(hasGap(full, 'type'), false);
  assert.equal(canFindLineup(bare), true);
  assert.equal(canFindLineup(bare, { jobId: 'j', status: 'needs_review', actCount: 3 }), false);
  assert.equal(canFindLineup(bare, { jobId: 'j', status: 'failed', actCount: 0 }), true);
  assert.equal(canFindLineup(ev('No date at all')), false);
});

test('find lineups for many: queued only, skipping what has a lineup, a lookup or no date', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'bulk-')));
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [],
    lateAdapters: [],
    gemini: null,
    quota: new QuotaLedger(store, { provider: 'gemini', model: 'x', dailyLimit: 1, perMinute: 1 }),
    search: null,
    now: () => NOW,
  };
  const a = ev('Show A 2024');
  const b = ev('Show B', {});
  const c = ev('Show C 2024', { editionId: 'e1' });
  for (const e of [a, b, c]) await store.putEvent(e);
  const r = await startBulkLookups(deps, [a.id, b.id, c.id, 'missing']);
  assert.deepEqual(r.started, [a.id]);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['no date', 'lineup already confirmed', 'not found']);
  const job = await store.getJob((await store.getEvent(a.id))!.lineupJobId!);
  assert.equal(job?.status, 'queued');
  // Started again: the queued lookup is left alone.
  const again = await startBulkLookups(deps, [a.id]);
  assert.deepEqual(again.skipped.map((s) => s.reason), ['lookup queued']);
  await assert.rejects(startBulkLookups(deps, Array.from({ length: 51 }, (_, i) => `x${i}`)));
});
