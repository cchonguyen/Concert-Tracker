import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { braveFinder, setlistfmFinder, ticketmasterFinder } from '../src/server/events/details.ts';
import { fakeFetcher } from './fakes.ts';

// Stage 1.3 baseline. Hand-written fixtures for the four failure shapes in
// docs/specs/event-fetch-upgrade-prd.md. They are not recorded from setlist.fm
// or Brave (their terms). These tests pin what the finders return today, so
// each failure is visible in code. Stage 2 to 5 change the expected values
// named in each comment; update the assertion in the same slice.

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/eventFetch/${name}`, import.meta.url), 'utf8'));

const keys = { TICKETMASTER_API_KEY: 'k', SETLISTFM_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'k' };

function withKeys<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  Object.assign(process.env, keys);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('crowded setlist.fm page: a full first page gives every act-named show in the year, with no city filter', () =>
  withKeys(async () => {
    const page = fixture('crowded-setlistfm.json');
    assert.equal(page.setlist.length, 20, 'the fixture is a full first page of 20');
    const { fetcher, calls } = fakeFetcher({ 'https://api.setlist.fm/rest/1.0/search/setlists': { body: page } });

    const found = await setlistfmFinder.find({ name: 'Gryffin', year: 2026 }, fetcher);

    // Today: 18 of the 2026 shows come back, none filtered by the typed city. The 2025 show and
    // "Gryffin & Friends" are dropped by year and name. Stage 2.2 keeps only the venue match or the
    // shows within the radius, and fetches page 2 because this page was full (20).
    assert.equal(found.length, 18);
    assert.ok(new Set(found.map((c) => c.city)).size >= 12, 'shows from many cities');
    assert.equal(calls.length, 1, 'page 2 is not fetched yet (Stage 2.2)');
  }));

test('crowded setlist.fm page: two Los Angeles shows in one year both come back as candidates', () =>
  withKeys(async () => {
    const { fetcher } = fakeFetcher({
      'https://api.setlist.fm/rest/1.0/search/setlists': { body: fixture('crowded-setlistfm.json') },
    });

    const found = await setlistfmFinder.find({ name: 'Gryffin', year: 2026 }, fetcher);
    const la = found.filter((c) => c.city?.startsWith('Los Angeles'));

    // Shrine Expo Hall (July and October) and the Wiltern, Fonda Theatre, The Forum (Inglewood) are all in the year.
    // Today the finder keeps all of them. Stage 5.2 stops any one of them being applied on its own.
    assert.ok(la.length >= 4, `expected several Los Angeles shows, got ${la.length}`);
  }));

test('metro suburb: a Ticketmaster show in Inglewood comes back with the suburb as its city, not Los Angeles', () =>
  withKeys(async () => {
    const { fetcher } = fakeFetcher({
      'https://app.ticketmaster.com/discovery/v2/events.json': { body: fixture('metro-suburb-ticketmaster.json') },
    });

    const found = await ticketmasterFinder.find({ name: 'Gryffin', year: 2026, city: 'Los Angeles' }, fetcher);

    // The finder has no notion of the typed city, so the suburb is stored as given.
    // Stage 2.1 and 2.2 keep it when its city is within METRO_RADIUS_MILES of Los Angeles.
    assert.equal(found.length, 1);
    assert.equal(found[0].venue, 'The Forum');
    assert.ok(found[0].city?.startsWith('Inglewood'), `city was ${found[0].city}`);
    assert.equal(found[0].startDate, '2026-10-10');
  }));

test('year-less snippet: a Brave result with a day and month but no year gives no candidate today', () =>
  withKeys(async () => {
    const { fetcher } = fakeFetcher({
      'https://api.search.brave.com/res/v1/web/search': { body: fixture('yearless-snippet-brave.json') },
    });

    const found = await braveFinder.find({ name: 'Gryffin', city: 'Los Angeles' }, fetcher);

    // The result names the act and the place, so it is read, but it has no full date, so nothing is a candidate.
    // Stage 4.2 fetches the page and reads its schema.org Event JSON-LD in code. Then this expects a candidate.
    assert.equal(found.length, 0);
  }));

test('same artist twice in a city: two different dates at two venues come back as two candidates', () =>
  withKeys(async () => {
    const { fetcher } = fakeFetcher({
      'https://api.setlist.fm/rest/1.0/search/setlists': { body: fixture('same-artist-twice-setlistfm.json') },
    });

    const found = await setlistfmFinder.find({ name: 'Gryffin', year: 2026, venue: 'Shrine Expo Hall', city: 'Los Angeles' }, fetcher);

    // Nothing ranks the typed venue first, and nothing blocks an auto-apply, so both come back.
    // Stage 5.1 ranks the Shrine Expo Hall show first. Stage 5.2 keeps both as choices, not an applied date.
    assert.deepEqual(
      found.map((c) => [c.startDate, c.venue]).sort(),
      [
        ['2026-10-05', 'Shrine Expo Hall'],
        ['2026-10-12', 'The Wiltern'],
      ],
    );
  }));
