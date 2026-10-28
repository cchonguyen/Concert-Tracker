import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoggedEvent } from '../src/server/events/types.ts';
import { buildShareView, isOver, todayIn } from '../src/server/share/view.ts';
import { shareEventOnly, ShareSettings } from '../src/server/share/types.ts';
import {
  createShareLink,
  findShareLink,
  hashShareCode,
  readShareSettings,
  revokeShareLinks,
  SHARE_CODE,
  updateShareSettings,
} from '../src/server/share/links.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const ev = (id: string, patch: Partial<LoggedEvent>): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});
const act = (name: string) => ({ key: name.toLowerCase(), name, from: 'you' as const });

const settings = (patch: Partial<ShareSettings> = {}): ShareSettings => ({
  displayName: 'Owner',
  timeZone: 'UTC',
  showDates: true,
  showVenues: true,
  showFormat: false,
  ...patch,
});
// Noon UTC on 2026-10-28.
const NOW = new Date('2026-10-28T12:00:00Z');

// Every field filled with a marker, so a test can tell which ones reach the page.
const marked = ev('marked', {
  input: 'MARK_INPUT',
  name: 'MARK_NAME',
  startDate: '2024-05-17',
  venue: 'MARK_VENUE',
  city: 'MARK_CITY',
  region: 'MARK_REGION',
  country: 'MARK_COUNTRY',
  sources: { venue: { sourceType: 'you', sourceUrl: 'https://MARK_SOURCE.example' } } as any,
  details: { status: 'resolved', candidates: [], notes: ['MARK_DETAILS'] },
  lineupJobId: 'MARK_JOB',
  editionId: 'MARK_EDITION',
  seen: [act('MARK_ACT')],
  format: 'MARK_FORMAT',
  weather: { summary: 'MARK_WEATHER' } as any,
  daysAttended: ['2024-05-17'],
  companions: ['MARK_COMPANION'],
  rating: 4.321,
  ticketPrice: 987.65,
  notes: 'MARK_NOTES',
});
const PRIVATE = ['MARK_INPUT', 'MARK_SOURCE', 'MARK_DETAILS', 'MARK_JOB', 'MARK_EDITION', 'MARK_WEATHER', 'MARK_COMPANION', '4.321', '987.65', 'MARK_NOTES'];

test('the share view carries only allow-listed fields', () => {
  const out = JSON.stringify(buildShareView([marked], settings({ showDates: false, showVenues: false }), NOW));
  for (const m of [...PRIVATE, 'MARK_VENUE', 'MARK_FORMAT', 'May 17']) assert.ok(!out.includes(m), `${m} leaked`);
  for (const m of ['MARK_NAME', 'MARK_CITY', 'MARK_REGION', 'MARK_COUNTRY', 'MARK_ACT', 'Owner']) assert.ok(out.includes(m), `${m} missing`);
});

test('switches add dates, venues and format, and nothing private', () => {
  const view = buildShareView([marked], settings({ showFormat: true }), NOW);
  const row = view.years[0].events[0];
  assert.equal(row.venue, 'MARK_VENUE');
  assert.deepEqual(row.formats, ['MARK_FORMAT']);
  assert.match(row.when!, /May 17/);
  const out = JSON.stringify(view);
  for (const m of PRIVATE) assert.ok(!out.includes(m), `${m} leaked`);
});

test('share events are loaded without private fields', () => {
  const e = shareEventOnly(marked);
  const out = JSON.stringify(e);
  for (const m of ['MARK_INPUT', 'MARK_SOURCE', 'MARK_JOB', 'MARK_WEATHER', 'MARK_COMPANION', '4.321', '987.65', 'MARK_NOTES']) assert.ok(!out.includes(m), `${m} loaded`);
  assert.equal(e.venue, 'MARK_VENUE');
});

test('only events fully over appear: nothing today, underway, ahead, undated or unconfirmed', () => {
  const today = '2026-10-28';
  const cases: Array<[string, Partial<LoggedEvent>, boolean]> = [
    ['yesterday', { startDate: '2026-10-27' }, true],
    ['today', { startDate: '2026-10-28' }, false],
    ['underway', { startDate: '2026-10-26', endDate: '2026-10-29' }, false],
    ['ended yesterday', { startDate: '2026-10-25', endDate: '2026-10-27' }, true],
    ['ahead', { startDate: '2026-11-02' }, false],
    ['this year only', { year: 2026 }, false],
    ['last year only', { year: 2025 }, true],
    ['this month only', { year: 2026, month: 10 }, false],
    ['last month only', { year: 2026, month: 9 }, true],
    ['undated', {}, false],
    ['planned and over', { startDate: '2026-10-01', attendance: 'planned' }, false],
    ['missed', { startDate: '2026-10-01', attendance: 'missed' }, false],
  ];
  for (const [name, patch, shown] of cases) assert.equal(isOver(ev(name, patch), today), shown, name);
  const view = buildShareView(cases.map(([n, p]) => ev(n, p)), settings(), NOW);
  assert.equal(view.totals.events, cases.filter((c) => c[2]).length);
  assert.deepEqual(view.years.flatMap((y) => y.events.map((e) => e.title)).sort(), cases.filter((c) => c[2]).map((c) => c[0]).sort());
});

test('today is the owner\'s today, not the server\'s', () => {
  // 23:30 on Oct 28 in Los Angeles is already Oct 29 in UTC.
  const lateEvening = new Date('2026-10-29T06:30:00Z');
  assert.equal(todayIn('America/Los_Angeles', lateEvening), '2026-10-28');
  const tonight = ev('tonight', { startDate: '2026-10-28' });
  assert.equal(buildShareView([tonight], settings({ timeZone: 'America/Los_Angeles' }), lateEvening).totals.events, 0);
  assert.equal(buildShareView([tonight], settings({ timeZone: 'UTC' }), lateEvening).totals.events, 1);
  // An unknown zone uses the last place to reach a new day.
  assert.equal(todayIn('Not/AZone', new Date('2026-10-29T06:30:00Z')), '2026-10-28');
});

test('with dates hidden, events in a year are listed A to Z; with dates shown, newest first', () => {
  const list = [ev('Zedd', { startDate: '2025-01-05' }), ev('Alpha', { startDate: '2025-12-01' }), ev('Mid', { startDate: '2025-06-01' })];
  const titles = (s: ShareSettings) => buildShareView(list, s, NOW).years[0].events.map((e) => e.title);
  assert.deepEqual(titles(settings({ showDates: false })), ['Alpha', 'Mid', 'Zedd']);
  assert.deepEqual(titles(settings()), ['Alpha', 'Mid', 'Zedd']); // Dec, Jun, Jan
  const reordered = [ev('B', { startDate: '2025-12-01' }), ev('A', { startDate: '2025-01-05' })];
  assert.deepEqual(buildShareView(reordered, settings(), NOW).years[0].events.map((e) => e.title), ['B', 'A']);
  assert.deepEqual(buildShareView(reordered, settings({ showDates: false }), NOW).years[0].events.map((e) => e.title), ['A', 'B']);
});

test('totals, most seen, series and cities', () => {
  const list = [
    ev('a', { startDate: '2023-05-19', endDate: '2023-05-21', series: 'EDC', city: 'Las Vegas', region: 'Nevada', country: 'United States', seen: [act('Odesza'), act('Bonobo')] }),
    ev('b', { startDate: '2024-05-17', endDate: '2024-05-19', series: 'EDC', city: 'Las Vegas', region: 'Nevada', country: 'United States', seen: [act('Odesza')] }),
    ev('c', { startDate: '2024-08-01', city: 'Los Angeles', region: 'California', country: 'USA', kind: 'concert', seen: [act('Bonobo')] }),
    ev('d', { year: 2022, city: 'London', country: 'United Kingdom' }),
  ];
  const v = buildShareView(list, settings(), NOW);
  assert.equal(v.totals.events, 4);
  assert.equal(v.totals.festivals, 2);
  assert.equal(v.totals.concerts, 1);
  assert.equal(v.totals.acts, 2);
  assert.equal(v.totals.cities, 3);
  assert.equal(v.totals.states, 2);
  assert.equal(v.totals.countries, 3);
  assert.equal(v.totals.firstYear, 2022);
  assert.equal(v.totals.lastYear, 2024);
  assert.deepEqual(v.mostSeen, [{ name: 'Bonobo', count: 2 }, { name: 'Odesza', count: 2 }]);
  assert.deepEqual(v.series, [{ name: 'EDC', years: [2023, 2024] }]);
  assert.deepEqual(v.cities[0], { name: 'Las Vegas, NV', count: 2 });
  assert.deepEqual(v.years.map((y) => y.year), [2024, 2023, 2022]);
  assert.equal(v.years[0].events[1].title, 'EDC Las Vegas 2024');
});

test('settings: a name and a real time zone are required; dates and venues default on, format off', () => {
  assert.deepEqual(readShareSettings({ displayName: '  Sam ', timeZone: 'America/New_York' }), {
    displayName: 'Sam',
    timeZone: 'America/New_York',
    showDates: true,
    showVenues: true,
    showFormat: false,
  });
  assert.equal(readShareSettings({ displayName: 'Sam', timeZone: 'UTC', showDates: false }).showDates, false);
  assert.throws(() => readShareSettings({ timeZone: 'UTC' }), /name/);
  assert.throws(() => readShareSettings({ displayName: 'x'.repeat(61), timeZone: 'UTC' }), /60/);
  assert.throws(() => readShareSettings({ displayName: 'Sam', timeZone: 'Mars/Base' }), /time zone/);
});

test('links: only the hash is stored, one link is active, and old or bad codes open nothing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'share-'));
  const store = new FileLineupStore(dir);
  const first = await createShareLink(store, settings(), NOW);
  assert.match(first.code, SHARE_CODE);
  assert.equal(first.link.codeHash, hashShareCode(first.code));
  assert.ok(!(await readFile(path.join(dir, 'lineup-store.json'), 'utf8')).includes(first.code), 'code stored');
  assert.equal((await findShareLink(store, first.code))?.id, first.link.id);

  const second = await createShareLink(store, settings({ displayName: 'New' }), NOW);
  assert.notEqual(second.code, first.code);
  assert.equal(await findShareLink(store, first.code), null);
  assert.equal((await findShareLink(store, second.code))?.settings.displayName, 'New');
  assert.equal((await store.listShareLinks()).filter((l) => !l.revokedAt).length, 1);

  assert.equal(await findShareLink(store, 'short'), null);
  assert.equal(await findShareLink(store, 'A'.repeat(22)), null);
  assert.equal(await findShareLink(store, `${second.code}/`), null);

  assert.equal((await updateShareSettings(store, settings({ showVenues: false })))?.settings.showVenues, false);
  assert.equal((await findShareLink(store, second.code))?.settings.showVenues, false);

  await revokeShareLinks(store, NOW);
  assert.equal(await findShareLink(store, second.code), null);
  assert.equal(await updateShareSettings(store, settings()), null);
});

test('the file store loads share events without private fields', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'share-')));
  await store.putEvent(marked);
  const out = JSON.stringify(await store.listShareEvents());
  for (const m of ['MARK_INPUT', 'MARK_COMPANION', 'MARK_NOTES', '987.65']) assert.ok(!out.includes(m), `${m} loaded`);
  assert.ok(out.includes('MARK_ACT'));
});
