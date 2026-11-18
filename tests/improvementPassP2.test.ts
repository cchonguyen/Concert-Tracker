import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isCalendarLine } from '../src/server/events/email/eventbrite.ts';
import { eventFromImport, mergeImports, mergeIntoEvent, readEmails } from '../src/server/events/email/imports.ts';
import type { EmailImport, RawEmail } from '../src/server/events/email/types.ts';
import { normalizeCountryDisplay } from '../src/server/events/regions.ts';
import { applyPatch, newEvent } from '../src/server/events/service.ts';
import { createLookup, PipelineDeps, runJob } from '../src/server/lineup/pipeline.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import { QuotaLedger } from '../src/server/lineup/quota.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { SourceAdapter } from '../src/server/lineup/types.ts';
import { createGuardedReader } from '../src/server/reader/guardedReader.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-11-18T12:00:00Z');

test('isCalendarLine matches combined and multi-token calendar footers without false positives on real venues', () => {
  assert.equal(isCalendarLine('Add to'), true);
  assert.equal(isCalendarLine('Add to my calendar:'), true);
  assert.equal(isCalendarLine('Add to Google · Outlook · iCal · Yahoo'), true);
  assert.equal(isCalendarLine('Add to my calendar: Google · Outlook · iCal · Yahoo'), true);
  assert.equal(isCalendarLine('Google · Outlook · iCal · Yahoo'), true);
  assert.equal(isCalendarLine('Add to Apple · Google · Outlook · Yahoo (View on map)'), true);

  assert.equal(isCalendarLine('The Echo'), false);
  assert.equal(isCalendarLine('Googleplex'), false);
  assert.equal(isCalendarLine('Yahoo! Theatre'), false);
  assert.equal(isCalendarLine(''), false);
});

test('eventbrite reader and mergeImports skip combined calendar footer lines and never store them as venues', () => {
  const withVenue: RawEmail = {
    id: 'eb-combined-1',
    link: 'https://mail.google.com/mail/u/0/#all/eb-combined-1',
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: 'Your Tickets for Neon Nights',
    sentAt: '2026-09-01T18:00:00Z',
    text: [
      'Neon Nights',
      '1 x General Admission',
      'Order total: $45.00',
      'Sat, Oct 10, 2026 9:00 PM PDT',
      'Add to Google · Outlook · iCal · Yahoo',
      'The Midway',
      '900 Marin St, San Francisco, CA 94124',
      '#77889900 - ordered by you',
    ].join('\n'),
  };
  const noVenue: RawEmail = {
    id: 'eb-combined-2',
    link: 'https://mail.google.com/mail/u/0/#all/eb-combined-2',
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: 'Your Tickets for Warehouse Afters',
    sentAt: '2026-09-01T18:00:00Z',
    text: [
      'Warehouse Afters',
      '1 x Early Bird',
      'Order total: $30.00',
      'Sat, Nov 14, 2026 10:00 PM PST',
      'Add to Google · Outlook · iCal · Yahoo',
      '#11223344 - ordered by you',
    ].join('\n'),
  };

  const { outcomes } = readEmails([withVenue, noVenue]);
  const [first, second] = outcomes;
  assert.ok('read' in first);
  assert.equal(first.read.venue?.value, 'The Midway');
  assert.equal(first.read.city?.value, 'San Francisco, CA');

  assert.ok('read' in second);
  assert.equal(second.read.venue, undefined);

  const rows = mergeImports([], outcomes, [], NOW);
  assert.equal(rows[0].venue, 'The Midway');
  assert.equal(rows[1].venue, undefined);
  assert.equal(rows[1].sources.venue, undefined);
});

test('eventFromImport and mergeIntoEvent strip legacy calendar-link venues stored on old EmailImport rows', () => {
  const legacyRow: EmailImport = {
    id: 'imp-legacy-1',
    key: 'eventbrite:555',
    status: 'new',
    seller: 'Eventbrite',
    name: 'Legacy Show',
    startDate: '2026-04-10',
    venue: 'Add to Google · Outlook · iCal · Yahoo',
    city: 'Los Angeles, CA',
    sources: {
      name: { messageId: 'm1', link: 'https://mail.example/m1', quote: 'Legacy Show' },
      startDate: { messageId: 'm1', link: 'https://mail.example/m1', quote: 'Fri, Apr 10, 2026' },
      venue: {
        messageId: 'm1',
        link: 'https://mail.example/m1',
        quote: 'Add to Google · Outlook · iCal · Yahoo',
      },
      city: { messageId: 'm1', link: 'https://mail.example/m1', quote: 'Los Angeles, CA' },
    },
    messages: [{ id: 'm1', link: 'https://mail.example/m1', subject: 'Your Tickets for Legacy Show', sentAt: '2026-03-01T00:00:00Z' }],
    flags: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };

  const created = eventFromImport(legacyRow, NOW);
  assert.equal(created.venue, undefined);
  assert.equal(created.sources.venue, undefined);
  assert.equal(created.city, 'Los Angeles, CA');

  const base = newEvent('Legacy Show', NOW);
  const merged = mergeIntoEvent(legacyRow, base, NOW);
  assert.equal(merged.event.venue, undefined);
  assert.equal(merged.event.sources.venue, undefined);
  assert.equal(merged.event.city, 'Los Angeles');
  assert.equal(merged.event.region, 'CA');
  assert.ok(!merged.filled.includes('venue'));
  assert.ok(merged.filled.includes('startDate'));
});

test('stageMerge seeds spellings from canonical_artists and lets member seen spellings override', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'p2-spellings-')));
  await store.ensureArtists([
    { key: 'tiesto', name: 'Tiësto' },
    { key: 'deadmau5', name: 'deadmau5' },
    { key: 'odesza', name: 'ODESZA' },
  ]);

  // Member previously logged "Deadmau5" with an uppercase D, which should win over canonical lowercase.
  const prior = applyPatch(newEvent('Prior Show Oct 1 2025', NOW), { seen: [{ name: 'Deadmau5' }] }, NOW);
  await store.putEvent(prior);

  const clashfinderAllCaps: SourceAdapter = {
    id: 'clashfinder',
    enabled: () => true,
    async collect() {
      const doc = makeDocument('https://clashfinder.com/s/test/', 'clashfinder', 'TIESTO\nDEADMAU5\nODESZA', 'json');
      return {
        documents: [doc],
        performers: ['TIESTO', 'DEADMAU5', 'ODESZA'].map((name) => ({
          documentId: doc.id,
          sourceType: 'clashfinder' as const,
          sourceUrl: doc.url,
          name,
          quotedSpan: name,
          evidence: 'crowd' as const,
          extractor: 'clashfinder',
          extractorVersion: 'test',
        })),
        facts: {},
        extractionQueue: [],
        notes: [],
      };
    },
  };

  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'fake', dailyLimit: 10, perMinute: 10 });
  const client = {
    provider: 'gemini' as const,
    model: 'fake',
    async extractPerformers() {
      return { ok: true as const, value: [], usage: { provider: 'gemini' as const, model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 } };
    },
    async extractEventDetails() {
      return { ok: true as const, value: {}, usage: { provider: 'gemini' as const, model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 } };
    },
  };
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [clashfinderAllCaps],
    lateAdapters: [],
    gemini: {
      model: 'fake',
      async extractPerformers() {
        return [];
      },
      async extractEventDetails() {
        return {};
      },
      async discoverLineupUrls() {
        return [];
      },
    },
    quota,
    reader: createGuardedReader({ client, store, quota, config: readReaderConfig({}), now: () => NOW }),
    search: null,
    now: () => NOW,
  };

  const job = await createLookup(deps, { eventName: 'Test Fest', year: 2026 });
  const done = await runJob(deps, job.id);
  const byKey = Object.fromEntries((done?.candidate?.performers ?? []).map((p) => [p.key, p.name]));

  assert.equal(byKey.tiesto, 'Tiësto');
  assert.equal(byKey.odesza, 'ODESZA');
  assert.equal(byKey.deadmau5, 'Deadmau5');
});

test('normalizeCountryDisplay canonicalizes patched aliases while leaving unpatched events untouched', () => {
  assert.equal(normalizeCountryDisplay('USA'), 'United States');
  assert.equal(normalizeCountryDisplay('us'), 'United States');
  assert.equal(normalizeCountryDisplay('U.S.A.'), 'United States');
  assert.equal(normalizeCountryDisplay('United States Of America'), 'United States');
  assert.equal(normalizeCountryDisplay('UK'), 'United Kingdom');
  assert.equal(normalizeCountryDisplay('gb'), 'United Kingdom');
  assert.equal(normalizeCountryDisplay('CAN'), 'Canada');
  assert.equal(normalizeCountryDisplay('ca'), 'Canada');
  assert.equal(normalizeCountryDisplay('Japan'), 'Japan');
  assert.equal(normalizeCountryDisplay('   '), undefined);
  assert.equal(normalizeCountryDisplay(null), undefined);

  const ev = newEvent('Show in Vegas', NOW);
  const patched = applyPatch(ev, { country: 'USA' }, NOW);
  assert.equal(patched.country, 'United States');

  const unpatchedCountry = { ...ev, country: 'USA' };
  const regionOnly = applyPatch(unpatchedCountry, { region: 'NV' }, NOW);
  assert.equal(regionOnly.country, 'USA');
});
