import assert from 'node:assert/strict';
import { test } from 'node:test';
import { braveFinder } from '../src/server/events/details.ts';
import { eventsFromPage } from '../src/server/events/place.ts';
import { fakeFetcher } from './fakes.ts';

// Stage 4.2: a web result that names the event but has no full date in its snippet is read through the page's own
// schema.org JSON-LD, in code. The quote comes from those fields, not the snippet.

const ldPage = (events: unknown[]) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(events)}</script></head><body>Tickets</body></html>`;

const gryffinEvent = {
  '@type': 'MusicEvent',
  name: 'Gryffin Live',
  startDate: '2026-10-10T20:00:00-07:00',
  location: { '@type': 'Place', name: 'The Forum', address: { addressLocality: 'Inglewood', addressRegion: 'CA', addressCountry: 'US' } },
};

test('stage 4.2: a snippet with no date reads the page JSON-LD into a candidate', async () => {
  const { fetcher, calls } = fakeFetcher({
    'https://api.search.brave.com/res/v1/web/search': {
      body: { web: { results: [{ url: 'https://tickets.example/gryffin', title: 'Gryffin Live at The Forum', description: 'Gryffin tickets, Los Angeles' }] } },
    },
    'https://tickets.example/gryffin': { body: ldPage([gryffinEvent]) },
  });
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  const found = await braveFinder.find({ name: 'Gryffin', year: 2026, city: 'Los Angeles' }, fetcher);
  assert.equal(found.length, 1);
  assert.equal(found[0].startDate, '2026-10-10');
  assert.equal(found[0].venue, 'The Forum');
  assert.ok(found[0].city?.startsWith('Inglewood'), `city was ${found[0].city}`);
  assert.equal(found[0].sources[0].quote, '2026-10-10 · The Forum · Inglewood, CA');
  assert.equal(calls.filter((u) => u.startsWith('https://tickets.example')).length, 1, 'one page read');
});

test('stage 4.2: AXS pages are never read', async () => {
  const { fetcher, calls } = fakeFetcher({
    'https://api.search.brave.com/res/v1/web/search': {
      body: { web: { results: [{ url: 'https://www.axs.com/events/gryffin', title: 'Gryffin tickets', description: 'Gryffin Los Angeles' }] } },
    },
    'https://www.axs.com/events/gryffin': { body: ldPage([gryffinEvent]) },
  });
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  const found = await braveFinder.find({ name: 'Gryffin', year: 2026, city: 'Los Angeles' }, fetcher);
  assert.equal(found.length, 0);
  assert.equal(calls.filter((u) => u.includes('axs.com')).length, 0);
});

test('stage 4.2: at most one page is read per search, even with several results', async () => {
  const { fetcher, calls } = fakeFetcher({
    'https://api.search.brave.com/res/v1/web/search': {
      body: {
        web: {
          results: [
            { url: 'https://a.example/1', title: 'Gryffin', description: 'Gryffin Los Angeles' },
            { url: 'https://b.example/2', title: 'Gryffin', description: 'Gryffin Los Angeles' },
          ],
        },
      },
    },
    'https://a.example/1': { body: ldPage([gryffinEvent]) },
    'https://b.example/2': { body: ldPage([gryffinEvent]) },
  });
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  await braveFinder.find({ name: 'Gryffin', year: 2026, city: 'Los Angeles' }, fetcher);
  assert.equal(calls.filter((u) => u.startsWith('https://a.example') || u.startsWith('https://b.example')).length, 1);
});

test('stage 4.2: JSON-LD events outside the window or not naming the act are ignored', () => {
  const page = ldPage([
    gryffinEvent,
    { ...gryffinEvent, startDate: '2025-10-10T20:00:00-07:00' },
    { ...gryffinEvent, name: 'Someone Else' },
  ]);
  const hits = eventsFromPage(page, 'Gryffin', '2026-01-01', '2026-12-31');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].startDate, '2026-10-10');
});
