import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findDates, parseEventInput } from '../src/server/events/parse.ts';
import {
  DetailFinder,
  mergeCandidates,
  pickCandidate,
  researchEvent,
  setlistfmFinder,
  ticketmasterFinder,
  braveFinder,
  webQuery,
} from '../src/server/events/details.ts';
import { applyPatch, newEvent, sortEvents, startLineupLookup } from '../src/server/events/service.ts';
import { DetailCandidate } from '../src/server/events/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { Edition } from '../src/server/lineup/types.ts';
import { cityLabel, citySuggestions, placeFromPage } from '../src/server/events/place.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-20T12:00:00Z');

test('parses name, date and place from one line, in your own words', () => {
  assert.deepEqual(parseEventInput('Porter Robinson at the Greek Theatre, Los Angeles, Oct 5 2024'), {
    name: 'Porter Robinson',
    year: 2024,
    startDate: '2024-10-05',
    venue: 'the Greek Theatre',
    city: 'Los Angeles',
  });
  assert.deepEqual(parseEventInput('EDC Las Vegas 2025'), { name: 'EDC Las Vegas', year: 2025 });
  assert.deepEqual(parseEventInput('Fred again.. in Brooklyn October 2023'), {
    name: 'Fred again..',
    year: 2023,
    month: 10,
    city: 'Brooklyn',
  });
  const fest = parseEventInput('Coachella May 16-18, 2025');
  assert.equal(fest.startDate, '2025-05-16');
  assert.equal(fest.endDate, '2025-05-18');
  assert.equal(parseEventInput('ODESZA @ Red Rocks 6/14/24').startDate, '2024-06-14');
  assert.equal(parseEventInput('ODESZA @ Red Rocks 6/14/24').venue, 'Red Rocks');
  assert.equal(parseEventInput('5th May 2019 Bonobo').startDate, '2019-05-05');
});

test('the parser never invents: no date stays no date, and band names keep their numbers', () => {
  assert.deepEqual(parseEventInput('Kaskade'), { name: 'Kaskade' });
  const band = parseEventInput('The 1975 at the Forum 2023');
  assert.equal(band.name, 'The 1975');
  assert.equal(band.year, 2023);
  assert.equal(parseEventInput('Blink-182').name, 'Blink-182');
  assert.equal(parseEventInput('Blink-182').year, undefined);
  assert.equal(parseEventInput('Show Feb 30 2024').startDate, undefined, 'impossible dates are not dates');
});

test('a new event stores what you typed, sourced to you, before any research', () => {
  const ev = newEvent('  Porter Robinson at the Greek, Oct 5 2024 ', NOW);
  assert.equal(ev.input, 'Porter Robinson at the Greek, Oct 5 2024');
  assert.equal(ev.name, 'Porter Robinson');
  assert.deepEqual(ev.sources.startDate, { sourceType: 'user' });
  assert.deepEqual(ev.sources.venue, { sourceType: 'user' });
  assert.equal(ev.city, undefined);
  assert.equal(ev.details.status, 'pending');
  assert.throws(() => newEvent('   ', NOW), /Type what you went to/);
});

const finder = (id: DetailFinder['id'], results: Omit<DetailCandidate, 'id'>[]): DetailFinder => ({
  id,
  enabled: () => true,
  find: async () => results.map((r, i) => ({ ...r, id: `${id}-${i}` })),
});
const src = (sourceType: DetailFinder['id'], fields: DetailCandidate['sources'][number]['fields']) => [
  { sourceType, sourceUrl: `https://${sourceType}.example/x`, fields },
];

test('research fills empty fields only when a source confirms the full date you gave', async () => {
  const ev = newEvent('Porter Robinson at the Greek Oct 5 2024', NOW);
  const tm = finder('setlistfm', [
    { startDate: '2024-10-05', venue: 'Greek Theatre', city: 'Los Angeles', sources: src('setlistfm', ['startDate', 'venue', 'city']) },
    { startDate: '2024-10-06', venue: 'Greek Theatre', city: 'Los Angeles', sources: src('setlistfm', ['startDate', 'venue', 'city']) },
  ]);
  const out = await researchEvent(ev, [tm], fakeFetcher({}).fetcher, NOW);
  assert.equal(out.details.status, 'matched');
  assert.equal(out.venue, 'the Greek', 'what you typed is kept');
  assert.equal(out.city, 'Los Angeles');
  assert.deepEqual(out.sources.city, { sourceType: 'setlistfm', sourceUrl: 'https://setlistfm.example/x' });
  assert.deepEqual(out.sources.venue, { sourceType: 'user' });
});

test('without a full date, research asks you to pick; picking fills fields, the name stays yours', async () => {
  const ev = newEvent('EDC Las Vegas 2025', NOW);
  const out = await researchEvent(
    ev,
    [
      finder('clashfinder', [{ name: 'EDC Las Vegas 2025', startDate: '2025-05-16', sources: src('clashfinder', ['startDate']) }]),
      finder('ticketmaster', [
        {
          name: 'EDC Las Vegas 2025 - 3 Day GA',
          startDate: '2025-05-16',
          endDate: '2025-05-18',
          venue: 'Las Vegas Motor Speedway',
          city: 'Las Vegas',
          sources: src('ticketmaster', ['startDate', 'endDate', 'venue', 'city']),
        },
      ]),
    ],
    fakeFetcher({}).fetcher,
    NOW,
  );
  assert.equal(out.details.status, 'choose');
  assert.equal(out.details.candidates.length, 1, 'same start date means the same occurrence');
  assert.equal(out.details.candidates[0].sources.length, 2);
  assert.equal(out.startDate, undefined, 'nothing applied without your pick');

  const picked = pickCandidate(out, out.details.candidates[0].id, NOW);
  assert.equal(picked.name, 'EDC Las Vegas');
  assert.equal(picked.startDate, '2025-05-16');
  assert.equal(picked.endDate, '2025-05-18');
  assert.equal(picked.venue, 'Las Vegas Motor Speedway');
  assert.equal(picked.sources.startDate?.sourceType, 'clashfinder');
  assert.equal(picked.sources.venue?.sourceType, 'ticketmaster');
  assert.equal(picked.details.status, 'resolved');

  const dismissed = pickCandidate(out, undefined, NOW);
  assert.equal(dismissed.startDate, undefined);
  assert.equal(dismissed.details.candidates.length, 0);
});

test('research needs a year, reports nothing found, and survives a failing source', async () => {
  const noYear = await researchEvent(newEvent('Kaskade', NOW), [finder('ticketmaster', [])], fakeFetcher({}).fetcher, NOW);
  assert.equal(noYear.details.status, 'needs_date');
  const broken: DetailFinder = { id: 'ticketmaster', enabled: () => true, find: async () => { throw new Error('HTTP 401'); } };
  const none = await researchEvent(newEvent('Kaskade 2024', NOW), [broken, finder('setlistfm', [])], fakeFetcher({}).fetcher, NOW);
  assert.equal(none.details.status, 'none');
  assert.ok(none.details.notes.some((n) => n.includes('ticketmaster failed: HTTP 401')));
});

test('mergeCandidates keeps undated candidates apart', () => {
  const merged = mergeCandidates([
    { id: 'a', venue: 'X', sources: src('ticketmaster', ['venue']) },
    { id: 'b', venue: 'Y', sources: src('setlistfm', ['venue']) },
  ]);
  assert.equal(merged.length, 2);
});

test('the setlist.fm finder keeps only that artist inside the window', async () => {
  process.env.SETLISTFM_API_KEY = 'k';
  try {
    const { fetcher, calls } = fakeFetcher({
      'https://api.setlist.fm/rest/1.0/search/setlists': {
        body: {
          setlist: [
            { eventDate: '05-10-2024', url: 'https://www.setlist.fm/a', artist: { name: 'Porter Robinson' }, venue: { name: 'Greek Theatre', city: { name: 'Los Angeles', country: { name: 'United States' } } } },
            { eventDate: '05-10-2024', url: 'https://www.setlist.fm/b', artist: { name: 'Porter Robinson Tribute' }, venue: { name: 'Bar' } },
          ],
        },
      },
    });
    const found = await setlistfmFinder.find({ name: 'Porter Robinson', year: 2024, startDate: '2024-10-05' }, fetcher);
    assert.equal(found.length, 1);
    assert.equal(found[0].country, 'United States');
    assert.ok(calls[0].includes('date=05-10-2024'));
  } finally {
    delete process.env.SETLISTFM_API_KEY;
  }
});

test('the Ticketmaster finder groups a festival listed once per day', async () => {
  process.env.TICKETMASTER_API_KEY = 'k';
  try {
    const venue = { name: 'Las Vegas Motor Speedway', city: { name: 'Las Vegas' } };
    const { fetcher } = fakeFetcher({
      'https://app.ticketmaster.com/': {
        body: {
          _embedded: {
            events: [
              { id: '1', name: 'EDC Las Vegas', dates: { start: { localDate: '2025-05-17' } }, _embedded: { venues: [venue] } },
              { id: '2', name: 'EDC Las Vegas', dates: { start: { localDate: '2025-05-16' } }, _embedded: { venues: [venue] } },
              { id: '3', name: 'Something Else', dates: { start: { localDate: '2025-05-16' } } },
            ],
          },
        },
      },
    });
    const found = await ticketmasterFinder.find({ name: 'EDC Las Vegas', year: 2025 }, fetcher);
    assert.equal(found.length, 1);
    assert.equal(found[0].startDate, '2025-05-16');
    assert.equal(found[0].endDate, '2025-05-17');
  } finally {
    delete process.env.TICKETMASTER_API_KEY;
  }
});

test('edits are yours, validated, and clear dependent fields', () => {
  const ev = newEvent('Bonobo 2019', NOW);
  const dated = applyPatch(ev, { startDate: '2019-05-05', endDate: '2019-05-04', city: 'London' }, NOW);
  assert.equal(dated.year, 2019);
  assert.equal(dated.endDate, undefined, 'an end before the start is dropped');
  assert.deepEqual(dated.sources.city, { sourceType: 'user' });
  const seen = applyPatch(dated, { seen: [{ name: 'Bonobo' }, { name: 'bonobo' }, { name: ' ' }], companions: ['Sam', 'Sam', ''] }, NOW);
  assert.deepEqual(seen.seen, [{ key: 'bonobo', name: 'Bonobo', from: 'you' }]);
  assert.deepEqual(seen.companions, ['Sam']);
  assert.throws(() => applyPatch(ev, { rating: 9 }, NOW), /Rating/);
  assert.throws(() => applyPatch(ev, { startDate: 'May 5' }, NOW), /YYYY-MM-DD/);
  assert.equal(applyPatch(dated, { city: null }, NOW).sources.city, undefined);
});

test('events sort newest first, with undated ones on top', () => {
  const a = { ...newEvent('A 2020', NOW) };
  const b = { ...newEvent('B Oct 5 2024', NOW) };
  const c = { ...newEvent('C', NOW) };
  assert.deepEqual(sortEvents([a, b, c]).map((e) => e.name), ['C', 'B', 'A']);
});

test('a lineup lookup from a dated event reuses an edition confirmed for that date, even under the old year key', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'events-')));
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [],
    lateAdapters: [],
    gemini: null,
    quota: null,
    search: null,
    now: () => NOW,
  };
  const edition: Edition = {
    id: 'ed1',
    key: 'porter-robinson/2024',
    seriesSlug: 'porter-robinson',
    year: 2024,
    name: 'Porter Robinson',
    startDate: '2024-10-05',
    status: 'confirmed',
    performances: [],
    updatedAt: NOW.toISOString(),
  };
  await store.upsertEdition(edition);

  const sameNight = newEvent('Porter Robinson Oct 5 2024', NOW);
  const hit = await startLineupLookup(deps, sameNight);
  assert.equal(hit.job.status, 'needs_review');
  assert.equal(hit.job.editionKey, 'porter-robinson/2024');
  assert.equal(hit.job.eventId, sameNight.id);
  assert.equal((await store.getEvent(sameNight.id))?.lineupJobId, hit.job.id);

  const otherNight = await startLineupLookup(deps, newEvent('Porter Robinson Nov 2 2024', NOW));
  assert.equal(otherNight.job.status, 'queued');
  assert.equal(otherNight.job.editionKey, 'porter-robinson/2024-11-02');

  await assert.rejects(startLineupLookup(deps, newEvent('Porter Robinson', NOW)), /a year is enough/);
});

test('findDates reads every full date in a text, with the words it came from', () => {
  assert.deepEqual(findDates('Doors 7pm. Porter Robinson live Oct 5, 2024 at the Greek; also 2024-10-06 and October 2024.'), [
    { startDate: '2024-10-05', endDate: undefined, quote: 'Oct 5, 2024' },
    { startDate: '2024-10-06', endDate: undefined, quote: '2024-10-06' },
  ]);
  assert.deepEqual(findDates('EDC Las Vegas May 16-18, 2025'), [{ startDate: '2025-05-16', endDate: '2025-05-18', quote: 'May 16-18, 2025' }]);
});

test('Brave results confirm a date only when they name the event and write the date in full', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const { fetcher, calls } = fakeFetcher({
      'https://api.search.brave.com/': {
        body: {
          web: {
            results: [
              { url: 'https://greek.example/porter', title: 'Porter Robinson | Greek Theatre', description: 'Porter Robinson performs <strong>Oct 5, 2024</strong>.' },
              { url: 'https://news.example/review', title: 'Review: Porter Robinson at the Greek', description: 'On October 5, 2024 the show sold out.' },
              { url: 'https://other.example/x', title: 'Madeon at the Greek', description: 'Oct 5, 2024' },
              { url: 'https://far.example/y', title: 'Porter Robinson tour', description: 'Next show March 1, 2025' },
            ],
          },
        },
      },
    });
    const q = { name: 'Porter Robinson', year: 2024, startDate: '2024-10-05', venue: 'the Greek' };
    assert.equal(webQuery(q), '"Porter Robinson" October 5 2024 the Greek');
    const found = await braveFinder.find(q, fetcher);
    assert.deepEqual(found.map((c) => c.sources[0].sourceUrl), ['https://greek.example/porter', 'https://news.example/review']);
    assert.equal(found[0].sources[0].quote, 'Oct 5, 2024');
    assert.ok(calls[0].includes('q=%22Porter%20Robinson%22'));

    const verified = await researchEvent(newEvent('Porter Robinson at the Greek Oct 5 2024', NOW), [braveFinder], fetcher, NOW);
    assert.equal(verified.details.status, 'matched');
    assert.equal(verified.details.candidates[0].sources.length, 2, 'two pages agree on the date');
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('a date backed by more sources wins when several cover yours; a tie asks you', async () => {
  const ev = newEvent('Fest May 17 2025', NOW);
  const twoAgree = await researchEvent(
    ev,
    [
      finder('discovered', [
        { startDate: '2025-05-16', endDate: '2025-05-18', sources: src('discovered', ['startDate', 'endDate']) },
        { startDate: '2025-05-17', sources: src('discovered', ['startDate']) },
      ]),
      finder('ticketmaster', [{ startDate: '2025-05-16', endDate: '2025-05-18', venue: 'Speedway', sources: src('ticketmaster', ['startDate', 'endDate', 'venue']) }]),
    ],
    fakeFetcher({}).fetcher,
    NOW,
  );
  assert.equal(twoAgree.details.status, 'matched');
  assert.equal(twoAgree.venue, 'Speedway');
  assert.equal(twoAgree.startDate, '2025-05-17', 'your date stays');

  const tie = await researchEvent(
    ev,
    [finder('discovered', [
      { startDate: '2025-05-16', endDate: '2025-05-18', sources: src('discovered', ['startDate', 'endDate']) },
      { startDate: '2025-05-17', sources: src('discovered', ['startDate']) },
    ])],
    fakeFetcher({}).fetcher,
    NOW,
  );
  assert.equal(tie.details.status, 'choose');
});

const ld = (data: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head><body></body></html>`;
const greekShow = {
  '@context': 'https://schema.org',
  '@type': 'MusicEvent',
  name: 'Porter Robinson: Nurture Live',
  startDate: '2024-10-05T19:30:00-07:00',
  location: { '@type': 'Place', name: 'Greek Theatre', address: { '@type': 'PostalAddress', addressLocality: 'Los Angeles', addressRegion: 'California', addressCountry: 'US' } },
};

test('cities are written "City, ST" in the US and Canada and as the city elsewhere', () => {
  assert.equal(cityLabel('Las Vegas', 'Nevada', 'US'), 'Las Vegas, NV');
  assert.equal(cityLabel('Las Vegas', 'NV'), 'Las Vegas, NV');
  assert.equal(cityLabel('Toronto', 'Ontario', 'Canada'), 'Toronto, ON');
  assert.equal(cityLabel('London', 'England', 'GB'), 'London');
  assert.equal(cityLabel('Springfield'), 'Springfield');
  assert.equal(cityLabel(undefined, 'NV'), undefined);
});

test('a page gives a place only from event markup for this event on a covered day', () => {
  assert.deepEqual(placeFromPage(ld(greekShow), 'Porter Robinson', '2024-10-05'), {
    venue: 'Greek Theatre',
    city: 'Los Angeles, CA',
    country: undefined,
    quote: 'Greek Theatre, Los Angeles, CA',
  });
  assert.equal(placeFromPage(ld(greekShow), 'Porter Robinson', '2024-10-06'), null, 'another day');
  assert.equal(placeFromPage(ld(greekShow), 'Madeon', '2024-10-05'), null, 'another act');
  assert.equal(placeFromPage('<p>Porter Robinson at the Greek Theatre</p>', 'Porter Robinson', '2024-10-05'), null, 'no markup, no place');
  const byPerformer = { ...greekShow, name: 'Nurture Live', performer: [{ '@type': 'MusicGroup', name: 'Porter Robinson' }] };
  assert.equal(placeFromPage(ld({ '@graph': [byPerformer] }), 'Porter Robinson', '2024-10-05')?.venue, 'Greek Theatre');
  const elsewhere = { ...greekShow, location: { name: 'Fox Theater', address: { addressLocality: 'Oakland', addressRegion: 'CA' } } };
  assert.equal(placeFromPage(ld([greekShow, elsewhere]), 'Porter Robinson', '2024-10-05'), null, 'two places is ambiguous');
  const festival = { ...greekShow, '@type': 'Festival', name: 'EDC Las Vegas 2025', startDate: '2025-05-16' };
  assert.equal(placeFromPage(ld(festival), 'EDC Las Vegas', '2025-05-16', '2025-05-18')?.city, 'Los Angeles, CA');
});

test('stage 1 reads the venue and city from the pages that confirmed the date', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const { fetcher, calls } = fakeFetcher({
      'https://api.search.brave.com/': {
        body: { web: { results: [{ url: 'https://tickets.example/porter', title: 'Porter Robinson', description: 'Sat Oct 5, 2024' }] } },
      },
      'https://tickets.example/porter': { body: ld(greekShow) },
    });
    const typed = newEvent('Porter Robinson Oct 5 2024', NOW);
    const out = await researchEvent(typed, [braveFinder], fetcher, NOW);
    assert.equal(out.details.status, 'matched');
    assert.equal(out.venue, 'Greek Theatre');
    assert.equal(out.city, 'Los Angeles, CA');
    assert.deepEqual(out.sources.venue, { sourceType: 'discovered', sourceUrl: 'https://tickets.example/porter' });
    const placeSource = out.details.candidates[0].sources.find((s) => s.fields.includes('venue'));
    assert.equal(placeSource?.quote, 'Greek Theatre, Los Angeles, CA');
    assert.ok(!placeSource?.fields.includes('startDate'), 'the place source does not count as another date confirmation');
    assert.equal(calls.length, 2);

    const yours = await researchEvent(newEvent('Porter Robinson at The Greek, Oct 5 2024', NOW), [braveFinder], fetcher, NOW);
    assert.equal(yours.venue, 'The Greek', 'a venue you typed is never replaced');
    assert.equal(yours.city, 'Los Angeles, CA', 'an empty city is filled');
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('city suggestions come from the geocoder as "City, ST", biggest first', async () => {
  const { fetcher, calls } = fakeFetcher({
    'https://geocoding-api.open-meteo.com/': {
      body: {
        results: [
          { name: 'Las Vegas', admin1: 'New Mexico', country_code: 'US', country: 'United States', feature_code: 'PPLA2', population: 13000 },
          { name: 'Las Vegas', admin1: 'Nevada', country_code: 'US', country: 'United States', feature_code: 'PPLA2', population: 640000 },
          { name: 'Las Vegas Wash', admin1: 'Nevada', country_code: 'US', feature_code: 'STM' },
          { name: 'Las Vegas', admin1: 'Santa Barbara', country_code: 'HN', country: 'Honduras', feature_code: 'PPL', population: 9000 },
        ],
      },
    },
  });
  assert.deepEqual(await citySuggestions('las vegas', fetcher), ['Las Vegas, NV', 'Las Vegas, NM', 'Las Vegas, Honduras']);
  assert.deepEqual(await citySuggestions('Las Vegas, N', fetcher), ['Las Vegas, NV', 'Las Vegas, NM', 'Las Vegas, Honduras'], 'cached');
  assert.equal(calls.length, 1);
  assert.deepEqual(await citySuggestions('L', fetcher), []);
});

test('without a year, web search suggests dates for that place and asks you to pick', async () => {
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  try {
    const { fetcher, calls } = fakeFetcher({
      'https://api.search.brave.com/': {
        body: {
          web: {
            results: [
              { url: 'https://a.example/1', title: 'Porter Robinson at the Greek Theatre', description: 'October 5, 2024' },
              { url: 'https://b.example/2', title: 'Porter Robinson live at Red Rocks', description: 'May 3, 2023' },
            ],
          },
        },
      },
    });
    const ev = newEvent('Porter Robinson at the Greek Theatre', NOW);
    assert.equal(ev.year, undefined);
    const out = await researchEvent(ev, [braveFinder, finder('ticketmaster', [{ startDate: '2025-01-01', sources: src('ticketmaster', ['startDate']) }])], fetcher, NOW);
    assert.equal(out.details.status, 'choose', 'a suggestion, never applied on its own');
    assert.deepEqual(out.details.candidates.map((c) => c.startDate), ['2024-10-05'], 'only the result naming your venue; Ticketmaster needs a year');
    assert.equal(out.startDate, undefined);
    assert.ok(decodeURIComponent(calls[0]).includes('"Porter Robinson"') && decodeURIComponent(calls[0]).includes('Greek Theatre'));
    const picked = pickCandidate(out, out.details.candidates[0].id, NOW);
    assert.equal(picked.year, 2024);

    const nothing = await researchEvent(newEvent('Nobody Plays Here', NOW), [braveFinder], fakeFetcher({}).fetcher, NOW);
    assert.equal(nothing.details.status, 'needs_date');
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('a renamed event that finds nothing is looked up again under the name you first typed', async () => {
  const seen: string[] = [];
  const byName: DetailFinder = {
    id: 'clashfinder',
    enabled: () => true,
    find: async (q) => {
      seen.push(q.name);
      return q.name === 'Coachella' ? [{ id: 'c', startDate: '2025-04-11', sources: src('clashfinder', ['startDate']) }] : [];
    },
  };
  const renamed = applyPatch(newEvent('Coachella Apr 11 2025', NOW), { name: 'Coachella Weekend 1' }, NOW);
  const out = await researchEvent(renamed, [byName], fakeFetcher({}).fetcher, NOW);
  assert.deepEqual(seen, ['Coachella Weekend 1', 'Coachella']);
  assert.equal(out.details.status, 'matched');
  assert.equal(out.name, 'Coachella Weekend 1', 'the name stays yours');
});

test('"Use this" takes one field from the confirmed suggestion and replaces what you typed', async () => {
  const ev = newEvent('Head in the Clouds in Pasadena May 31 2025', NOW);
  const out = await researchEvent(
    ev,
    [finder('discovered', [{ startDate: '2025-05-31', venue: 'Brookside at the Rose Bowl', city: 'Pasadena, CA', sources: src('discovered', ['startDate', 'venue', 'city']) }])],
    fakeFetcher({}).fetcher,
    NOW,
  );
  assert.equal(out.city, 'Pasadena', 'look again never replaces your city');
  assert.equal(out.venue, 'Brookside at the Rose Bowl');
  const used = pickCandidate(out, out.details.candidates[0].id, NOW, ['city']);
  assert.equal(used.city, 'Pasadena, CA');
  assert.equal(used.sources.city?.sourceType, 'discovered');
  assert.equal(used.details.status, 'matched', 'the suggestion stays');
  assert.throws(() => pickCandidate(out, out.details.candidates[0].id, NOW, ['name' as never]));
  assert.equal(cityLabel('Los Angeles,', 'CA'), 'Los Angeles, CA');
});
