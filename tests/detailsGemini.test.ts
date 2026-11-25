import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { braveFinder, researchEditionFacts, researchEvent } from '../src/server/events/details.ts';
import { checkedCandidate, checkedInferences, geminiReader, rung4Urls, rung4Wanted, runReaderPage } from '../src/server/events/detailsGemini.ts';
import { storeReaderInferences, type ReaderInferenceInput } from '../src/server/canon/inferences.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import type { Edition } from '../src/server/lineup/types.ts';
import { newEvent } from '../src/server/events/service.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { guardedFromGemini } from '../src/server/reader/guardedReader.ts';
import { QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-20T12:00:00Z');
const PAGE = '<html><body><h1>Porter Robinson: Smile! :D World Tour</h1><p>Saturday, Oct 5, 2024 · Greek Theatre, Los Angeles, CA</p></body></html>';

type Answer = Record<string, unknown>;
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

test('Deep search with AI reads the page a search found and fills the place your date matches', async () => {
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
    assert.ok(out.details.notes.some((n) => n.includes('nothing was sent to the AI')));
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

// Slice 11.17: rung 4, the reader in its own queue message per page.
const URL_A = 'https://greek.example/porter';
function dated(event: ReturnType<typeof newEvent>, urls: string[], date = '2024-10-05') {
  return {
    ...event,
    details: {
      ...event.details,
      status: 'matched' as const,
      candidates: urls.map((u) => ({ id: u, startDate: date, sources: [{ sourceType: 'discovered' as const, sourceUrl: u, fields: ['startDate' as const], quote: 'Oct 5, 2024' }] })),
    },
  };
}
function memory(ev: ReturnType<typeof newEvent>) {
  let cur = ev;
  return { get: () => cur, getEvent: async () => cur, putEvent: async (e: typeof ev) => { cur = e; } };
}
const place = { dateQuote: 'Oct 5, 2024', venue: 'Greek Theatre', city: 'Los Angeles, CA', placeQuote: 'Greek Theatre, Los Angeles, CA' };

test('rung 4 is wanted only with a full date and a gap; one page per message, at most 2, never AXS', () => {
  const base = newEvent('Porter Robinson Oct 5 2024', NOW);
  assert.equal(base.startDate, '2024-10-05');
  assert.equal(rung4Wanted(base), true);
  assert.equal(rung4Wanted({ ...base, venue: 'V', city: 'C' }), false);
  assert.equal(rung4Wanted({ ...base, venue: 'V' }), true);
  assert.equal(rung4Wanted({ ...base, startDate: undefined }), false);
  const three = dated(base, [URL_A, 'https://www.axs.com/e/1', 'https://b.example/x', 'https://c.example/y']);
  assert.deepEqual(rung4Urls(three), [URL_A, 'https://b.example/x']);
  assert.deepEqual(rung4Urls(dated(base, [URL_A], '2024-10-06')), []); // pages for another date are not read
  assert.deepEqual(rung4Urls({ ...three, startDate: undefined }), []);
});

test('rung 4 reads one page, fills only empty fields and keeps what you typed', async () => {
  const calls = { n: 0 };
  const { reader } = await readerFor(fakeGemini(() => place, calls));
  const { fetcher } = fakeFetcher({ [URL_A]: { body: PAGE } });
  const typed = { ...dated(newEvent('Porter Robinson Oct 5 2024', NOW), [URL_A]), venue: 'My Venue' };
  const mem = memory(typed);
  assert.equal(await runReaderPage(mem, reader, typed.id, URL_A, fetcher, NOW), 'applied');
  assert.equal(calls.n, 1);
  assert.equal(mem.get().venue, 'My Venue'); // typed, never overwritten
  assert.equal(mem.get().city, 'Los Angeles');
  assert.equal(mem.get().startDate, '2024-10-05');
  assert.ok(mem.get().details.notes.some((n) => n.startsWith('gemini (auto): read')));
  // Nothing left to fill: a second message makes no call.
  assert.equal(await runReaderPage(mem, reader, typed.id, URL_A, fetcher, NOW), 'skipped');
});

test('rung 4 fills nothing when the page date is not the date you gave', async () => {
  const calls = { n: 0 };
  const other = PAGE.replace('Oct 5, 2024', 'Oct 6, 2024');
  const { reader } = await readerFor(fakeGemini(() => ({ ...place, dateQuote: 'Oct 6, 2024' }), calls));
  const { fetcher } = fakeFetcher({ [URL_A]: { body: other } });
  const ev = dated(newEvent('Porter Robinson Oct 5 2024', NOW), [URL_A]);
  const mem = memory(ev);
  await runReaderPage(mem, reader, ev.id, URL_A, fetcher, NOW);
  assert.equal(calls.n, 1);
  assert.equal(mem.get().venue, undefined);
  assert.equal(mem.get().city, undefined);
});

test('rung 4 skips a page of 30,000 characters or more without a call or cutting it', async () => {
  const calls = { n: 0 };
  const { reader } = await readerFor(fakeGemini(() => place, calls));
  const big = `<p>Porter Robinson Oct 5, 2024 Greek Theatre, Los Angeles, CA ${'x'.repeat(30000)}</p>`;
  const { fetcher } = fakeFetcher({ [URL_A]: { body: big } });
  const ev = dated(newEvent('Porter Robinson Oct 5 2024', NOW), [URL_A]);
  const mem = memory(ev);
  assert.equal(await runReaderPage(mem, reader, ev.id, URL_A, fetcher, NOW), 'nothing');
  assert.equal(calls.n, 0);
  assert.equal(mem.get().venue, undefined);
  assert.ok(mem.get().details.notes.some((n) => n.includes('30,000')));
});

test('rung 4 parks on a quota error or a guard block: a note, no fallback, no retry', async () => {
  const refusing: Generator = {
    model: 'fake-lite',
    async generate() {
      throw new QuotaExhaustedError(new Date('2026-10-21T07:00:00Z'), 'Gemini daily limit reached');
    },
  };
  const { fetcher } = fakeFetcher({ [URL_A]: { body: PAGE } });
  const ev = dated(newEvent('Porter Robinson Oct 5 2024', NOW), [URL_A]);
  const mem = memory(ev);
  assert.equal(await runReaderPage(mem, (await readerFor(refusing)).reader, ev.id, URL_A, fetcher, NOW), 'parked');
  assert.equal(mem.get().venue, undefined);
  assert.ok(mem.get().details.notes.includes('gemini (auto): stopped, Gemini daily limit reached'));

  const calls = { n: 0 };
  const blocked = (await readerFor(fakeGemini(() => place, calls), 0)).reader; // daily limit 0: guard stops it
  const mem2 = memory(ev);
  assert.equal(await runReaderPage(mem2, blocked, ev.id, URL_A, fetcher, NOW), 'parked');
  assert.equal(calls.n, 0);
  assert.equal(mem2.get().city, undefined);
});

test('checkedCandidate verifies weekendQuotes verbatim, reads dates in code, and rejects hallucinated quotes', () => {
  const q = { name: 'Coachella', year: 2025 };
  const text = 'Coachella 2025 · Weekend 1: April 11-13, 2025 and Weekend 2: April 18-20, 2025 at Empire Polo Club, Indio, CA';

  const multi = checkedCandidate(q, 'https://coachella.example/2025', text, {
    weekendQuotes: ['Weekend 1: April 11-13, 2025', 'Weekend 2: April 18-20, 2025'],
    venue: 'Empire Polo Club',
    city: 'Indio, CA',
    placeQuote: 'Empire Polo Club, Indio, CA',
  });
  assert.equal(multi?.startDate, '2025-04-11');
  assert.equal(multi?.endDate, '2025-04-20');
  assert.deepEqual(multi?.weekends, [
    { weekend: 1, startDate: '2025-04-11', endDate: '2025-04-13' },
    { weekend: 2, startDate: '2025-04-18', endDate: '2025-04-20' },
  ]);
  assert.equal(multi?.venue, 'Empire Polo Club');
  assert.equal(multi?.city, 'Indio, CA');
  assert.ok(multi?.sources[0].quote?.includes('Weekend 1: April 11-13, 2025'));
  assert.ok(multi?.sources[0].quote?.includes('Weekend 2: April 18-20, 2025'));

  // Implicit numbering when quotes omit "Weekend N", sorted chronologically and deduplicated.
  const noLabelText = 'Festival dates: April 18-20, 2025 and April 11-13, 2025.';
  const implicit = checkedCandidate(q, 'https://fest.example', noLabelText, {
    weekendQuotes: ['April 18-20, 2025', 'April 11-13, 2025', 'April 11-13, 2025'],
  });
  assert.deepEqual(implicit?.weekends, [
    { weekend: 1, startDate: '2025-04-11', endDate: '2025-04-13' },
    { weekend: 2, startDate: '2025-04-18', endDate: '2025-04-20' },
  ]);

  // Hallucinated weekend quote is dropped; with valid dateQuote it falls back to single range without weekends.
  const partialHallucinated = checkedCandidate(q, 'https://coachella.example/2025', text, {
    dateQuote: 'April 11-13, 2025',
    weekendQuotes: ['Weekend 1: April 11-13, 2025', 'Weekend 2: April 25-27, 2025'],
  });
  assert.equal(partialHallucinated?.startDate, '2025-04-11');
  assert.equal(partialHallucinated?.endDate, '2025-04-13');
  assert.equal(partialHallucinated?.weekends, undefined);

  // Fully hallucinated weekendQuotes with no valid dateQuote is rejected.
  assert.equal(
    checkedCandidate(q, 'https://coachella.example/2025', text, {
      weekendQuotes: ['Weekend 1: May 1-3, 2025', 'Weekend 2: May 8-10, 2025'],
    }),
    null,
  );
});

test('researchEditionFacts with Gemini extracts verified multi-weekend dates and place', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const calls = { n: 0 };
    const gemini = fakeGemini(
      () => ({
        dateQuote: 'April 11-13, 2025',
        weekendQuotes: ['Weekend 1: April 11-13, 2025', 'Weekend 2: April 18-20, 2025'],
        venue: 'Empire Polo Club',
        city: 'Indio, CA',
        placeQuote: 'Empire Polo Club, Indio, CA',
      }),
      calls,
    );
    const { fetcher } = fakeFetcher({
      'https://api.search.brave.com/': {
        body: { web: { results: [{ url: 'https://fest.example/coachella', title: 'Coachella 2025', description: 'Dates announced.' }] } },
      },
      'https://fest.example/coachella': {
        body: '<p>Coachella 2025 · Weekend 1: April 11-13, 2025 · Weekend 2: April 18-20, 2025 · Empire Polo Club, Indio, CA</p>',
      },
    });
    const { reader } = await readerFor(gemini);
    const res = await researchEditionFacts({ id: 'ed-coachella', name: 'Coachella', year: 2025 }, [braveFinder], {
      fetcher,
      now: NOW,
      reader,
      useGemini: true,
    });
    assert.equal(calls.n, 1);
    assert.equal(res.status, 'choose');
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0].startDate, '2025-04-11');
    assert.equal(res.candidates[0].endDate, '2025-04-20');
    assert.deepEqual(res.candidates[0].weekends, [
      { weekend: 1, startDate: '2025-04-11', endDate: '2025-04-13' },
      { weekend: 2, startDate: '2025-04-18', endDate: '2025-04-20' },
    ]);
    assert.equal(res.candidates[0].venue, 'Empire Polo Club');
    assert.equal(res.candidates[0].city, 'Indio, CA');
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

const INF_URL = 'https://greek.example/porter';
const INF_TEXT = 'Porter Robinson Saturday, Oct 5, 2024 · Greek Theatre, 2700 N Vermont Ave, Los Angeles, CA';
const INF_Q = { name: 'Porter Robinson', year: 2024 };
const infCandidate = () => checkedCandidate(INF_Q, INF_URL, INF_TEXT, { dateQuote: 'Oct 5, 2024', venue: 'Greek Theatre', placeQuote: 'Greek Theatre' });

test('checkedInferences keeps a supported city and region, and drops dates, stated fields and quotes not on the page', () => {
  const got = {
    inferred: [
      { field: 'city', value: 'Los Angeles', quote: '2700 N Vermont Ave, Los Angeles, CA', reason: 'the street address names Los Angeles' },
      { field: 'venue', value: 'Greek Theatre', quote: 'Greek Theatre', reason: 'the venue line' }, // the candidate already states the venue
      { field: 'startDate', value: '2025-01-01', quote: 'Oct 5, 2024', reason: 'a date' }, // dates are never inferred
      { field: 'endDate', value: '2024-10-06', quote: 'Oct 5, 2024', reason: 'a date' },
      { field: 'region', value: 'CA', quote: 'Los Angeles, CA', reason: 'the line ends with CA' },
      { field: 'country', value: 'USA', quote: 'Oslo, Norway', reason: 'not on this page' }, // quote not on the page
    ],
  };
  const out = checkedInferences(INF_URL, INF_TEXT, got, infCandidate());
  assert.deepEqual(
    out.map((i) => [i.field, i.value]),
    [
      ['city', 'Los Angeles'],
      ['region', 'CA'],
    ],
  );
  assert.equal(out[0].url, INF_URL);
  assert.equal(out[0].quote, '2700 N Vermont Ave, Los Angeles, CA');
});

test('checkedInferences means none without a checked candidate, and collapses duplicates and long reasons', () => {
  const inferred = [{ field: 'city', value: 'Los Angeles', quote: 'Los Angeles, CA', reason: 'the line names the city' }];
  assert.deepEqual(checkedInferences(INF_URL, INF_TEXT, { inferred }, null), []);
  const dup = checkedInferences(INF_URL, INF_TEXT, {
    inferred: [
      ...inferred,
      { field: 'city', value: 'Anaheim', quote: 'Los Angeles, CA', reason: 'a second city, dropped' },
      { field: 'region', value: 'CA', quote: 'Los Angeles, CA', reason: 'x'.repeat(201) }, // reason too long
    ],
  }, infCandidate());
  assert.deepEqual(dup.map((i) => [i.field, i.value]), [['city', 'Los Angeles']]);
  assert.deepEqual(checkedInferences(INF_URL, INF_TEXT, {}, infCandidate()), []);
});

test('Deep search with AI passes the checked inferences to onInferences and never a date', async () => {
  const calls = { n: 0 };
  const gemini = fakeGemini(
    () => ({
      dateQuote: 'Oct 5, 2024',
      inferred: [
        { field: 'city', value: 'Los Angeles', quote: 'Greek Theatre, 2700 N Vermont Ave, Los Angeles', reason: 'the street address names the city' },
        { field: 'startDate', value: '2025-01-01', quote: 'Oct 5, 2024', reason: 'a date' },
      ],
    }),
    calls,
  );
  const { fetcher } = fakeFetcher({ [INF_URL]: { body: `<p>${INF_TEXT}</p>` } });
  const seen: ReaderInferenceInput[][] = [];
  const notes: string[] = [];
  const { reader } = await readerFor(gemini);
  const out = await geminiReader(reader, 'evt-1', () => NOW, { onInferences: (list) => seen.push(list) }).read(INF_Q, [INF_URL], fetcher, notes);
  assert.equal(calls.n, 1);
  assert.equal(out.length, 1);
  assert.deepEqual(seen.map((l) => l.map((i) => i.field)), [['city']]);
  assert.ok(notes.some((n) => n === `gemini: inferred city from ${INF_URL}.`));
});

test('storeReaderInferences stores an empty field as a reader inference with its source, and skips a field the edition has', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'reader-infer-')));
  const edition: Edition = {
    id: 'e1', key: 'porter/2024', seriesSlug: 'porter', year: 2024, name: 'Porter Robinson', status: 'provisional',
    updatedAt: '2024-01-01T00:00:00.000Z', performances: [], venue: 'Greek Theatre',
  };
  await writeEdition(store, { edition, actor: 'system:test', reason: 'created' });
  const current = (await store.getEdition('e1'))!;
  const list: ReaderInferenceInput[] = [
    { field: 'city', value: 'Los Angeles', quote: 'Greek Theatre, 2700 N Vermont Ave, Los Angeles', reason: 'the street address names the city', url: INF_URL },
    { field: 'venue', value: 'Hollywood Bowl', quote: 'Greek Theatre', reason: 'the venue line', url: INF_URL }, // the edition has a venue
  ];
  const stored = await storeReaderInferences(store, current, list);
  assert.equal(stored.length, 1);
  const [inf] = await store.listEditionInferences('e1');
  assert.equal(inf.field, 'city');
  assert.equal(inf.value, 'Los Angeles');
  assert.equal(inf.rule, 'reader');
  assert.equal(inf.actor, 'system:reader-infer');
  assert.match(inf.reason, /read from greek\.example\)$/);
  assert.deepEqual(inf.inputs, [{ kind: 'source', url: INF_URL, quote: 'Greek Theatre, 2700 N Vermont Ave, Los Angeles' }]);
  assert.equal((await store.getEdition('e1'))!.city, undefined);
});
