import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { braveFinder, researchEvent } from '../src/server/events/details.ts';
import { checkedCandidate, geminiReader } from '../src/server/events/detailsGemini.ts';
import { newEvent } from '../src/server/events/service.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { guardedFromGemini } from '../src/server/reader/guardedReader.ts';
import { QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-20T12:00:00Z');
const PAGE = '<html><body><h1>Porter Robinson: Smile! :D World Tour</h1><p>Saturday, Oct 5, 2024 · Greek Theatre, Los Angeles, CA</p></body></html>';

type Answer = Record<string, string>;
type Generator = { model: string; generate: (a: unknown) => Promise<{ text: string; promptTokens: number; candidatesTokens: number; thoughtsTokens: number }> };

function fakeGemini(answer: () => Answer, calls: { n: number }): Generator {
  return {
    model: 'fake-lite',
    async generate() {
      calls.n += 1;
      return { text: JSON.stringify(answer()), promptTokens: 10, candidatesTokens: 10, thoughtsTokens: 0 };
    },
  };
}

async function setup(limit = 50) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'details-gemini-')));
  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: limit, perMinute: 100 });
  return { store, quota };
}

async function readerFor(gen: Generator, limit = 50, config = readReaderConfig({})) {
  const { store, quota } = await setup(limit);
  return { store, reader: guardedFromGemini(gen as never, store, quota, () => NOW, config) };
}

const brave = {
  'https://api.search.brave.com/': {
    body: { web: { results: [{ url: 'https://greek.example/porter', title: 'Porter Robinson | Greek Theatre', description: 'Tickets on sale now.' }] } },
  },
  'https://greek.example/porter': { body: PAGE },
};

test('checkedCandidate keeps only values written on the page, and reads the date in code', () => {
  const q = { name: 'Porter Robinson', year: 2024 };
  const text = 'Porter Robinson Saturday, Oct 5, 2024 · Greek Theatre, Los Angeles, CA';
  const c = checkedCandidate(q, 'https://greek.example/porter', text, {
    dateQuote: 'Oct 5, 2024',
    venue: 'Greek Theatre',
    city: 'Los Angeles, CA',
    country: 'United States', // not on the page: dropped
    placeQuote: 'Greek Theatre, Los Angeles, CA',
  });
  assert.equal(c?.startDate, '2024-10-05');
  assert.equal(c?.venue, 'Greek Theatre');
  assert.equal(c?.city, 'Los Angeles, CA');
  assert.equal(c?.country, undefined);
  assert.deepEqual(c?.sources[0].fields, ['startDate', 'venue', 'city']);
  assert.equal(c?.sources[0].readBy, 'gemini');

  // A quote that is not on the page, or a date outside the year, gives nothing.
  assert.equal(checkedCandidate(q, 'u', text, { dateQuote: 'Oct 6, 2024', venue: 'Greek Theatre', placeQuote: 'Greek Theatre' }), null);
  assert.equal(checkedCandidate({ ...q, year: 2025 }, 'u', `${text} 2025`, { dateQuote: 'Oct 5, 2024' }), null);
  // A place whose quote is invented is left out; the date still counts.
  const noPlace = checkedCandidate(q, 'u', text, { dateQuote: 'Oct 5, 2024', venue: 'Hollywood Bowl', placeQuote: 'Hollywood Bowl' });
  assert.deepEqual(noPlace?.sources[0].fields, ['startDate']);
});

test('Look again with Gemini reads the page a search found and fills the place your date matches', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const calls = { n: 0 };
    const gemini = fakeGemini(
      () => ({ dateQuote: 'Oct 5, 2024', venue: 'Greek Theatre', city: 'Los Angeles, CA', placeQuote: 'Greek Theatre, Los Angeles, CA' }),
      calls,
    );
    const { fetcher } = fakeFetcher(brave);
    const event = newEvent('Porter Robinson Oct 5 2024', NOW);

    // Without Gemini the search result gives no date and no place.
    const plain = await researchEvent(event, [braveFinder], fetcher, NOW);
    assert.equal(plain.details.status, 'none');
    assert.equal(calls.n, 0);

    const read = await researchEvent(event, [braveFinder], fetcher, NOW, geminiReader((await readerFor(gemini)).reader, event.id, () => NOW));
    assert.equal(calls.n, 1);
    assert.equal(read.details.status, 'matched');
    assert.equal(read.venue, 'Greek Theatre');
    assert.equal(read.city, 'Los Angeles');
    assert.equal(read.region, 'CA');
    assert.equal(read.sources.venue?.sourceUrl, 'https://greek.example/porter');
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('a page that does not name the event is never sent to Gemini', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const calls = { n: 0 };
    const gemini = fakeGemini(() => ({ dateQuote: 'Oct 5, 2024' }), calls);
    const { fetcher } = fakeFetcher({ ...brave, 'https://greek.example/porter': { body: '<p>Madeon, Oct 5, 2024</p>' } });
    const ev = newEvent('Porter Robinson Oct 5 2024', NOW);
    const out = await researchEvent(ev, [braveFinder], fetcher, NOW, geminiReader((await readerFor(gemini)).reader, ev.id, () => NOW));
    assert.equal(calls.n, 0);
    assert.ok(out.details.notes.some((n) => n.includes('no Gemini call')));
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('out of Gemini quota, it stops and says so; no other reader steps in', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const calls = { n: 0 };
    const spent = fakeGemini(() => ({}), calls);
    const { fetcher } = fakeFetcher(brave);
    const event = newEvent('Porter Robinson Oct 5 2024', NOW);
    const out = await researchEvent(event, [braveFinder], fetcher, NOW, geminiReader((await readerFor(spent, 0)).reader, event.id, () => NOW));
    assert.equal(calls.n, 0);
    assert.equal(out.venue, undefined);
    assert.ok(out.details.notes.some((n) => n.startsWith('gemini: stopped')));

    const refusing: Generator = {
      ...spent,
      async generate() {
        throw new QuotaExhaustedError(new Date('2026-10-21T07:00:00Z'), 'Gemini daily limit reached');
      },
    };
    const parked = await researchEvent(event, [braveFinder], fetcher, NOW, geminiReader((await readerFor(refusing)).reader, event.id, () => NOW));
    assert.ok(parked.details.notes.some((n) => n === 'gemini: stopped, Gemini daily limit reached'));
    assert.equal(parked.venue, undefined);
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('the details press makes at most 3 calls, one per page, under the details_extract feature', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const calls = { n: 0 };
    const gen = fakeGemini(() => ({}), calls);
    const urls = [1, 2, 3, 4, 5].map((i) => `https://greek.example/p${i}`);
    const pages: Record<string, { body: unknown }> = {
      'https://api.search.brave.com/': { body: { web: { results: urls.map((url) => ({ url, title: 'Porter Robinson', description: 'x' })) } } },
    };
    for (const u of urls) pages[u] = { body: PAGE };
    const { fetcher } = fakeFetcher(pages);
    const ev = newEvent('Porter Robinson Oct 5 2024', NOW);
    const { store, reader } = await readerFor(gen);
    await researchEvent(ev, [braveFinder], fetcher, NOW, geminiReader(reader, ev.id, () => NOW));
    assert.equal(calls.n, 3);
    const rows = (await store.listAiCalls?.({} as never)) as { feature: string; eventId: string }[] | undefined;
    if (rows) assert.ok(rows.every((r) => r.feature === 'details_extract' && r.eventId === ev.id));
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('a guard block (job cap) stops the press with a note and no other reader steps in', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const calls = { n: 0 };
    const gen = fakeGemini(() => ({}), calls);
    const two = {
      'https://api.search.brave.com/': { body: { web: { results: ['a', 'b'].map((k) => ({ url: `https://greek.example/${k}`, title: 'Porter Robinson', description: 'x' })) } } },
      'https://greek.example/a': { body: PAGE },
      'https://greek.example/b': { body: PAGE },
    };
    const { fetcher } = fakeFetcher(two);
    const ev = newEvent('Porter Robinson Oct 5 2024', NOW);
    const { reader } = await readerFor(gen, 50, readReaderConfig({ READER_MAX_CALLS_PER_JOB: '1' }));
    const out = await researchEvent(ev, [braveFinder], fetcher, NOW, geminiReader(reader, ev.id, () => NOW));
    assert.equal(calls.n, 1);
    assert.ok(out.details.notes.some((n) => n.startsWith('gemini: stopped')));
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});
