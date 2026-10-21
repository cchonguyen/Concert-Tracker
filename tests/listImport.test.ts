import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmailImport } from '../src/server/events/email/types.ts';
import { EventPatch } from '../src/server/events/service.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { fillPatch, findMatches, ImportApi, newEventPatch, parseCsv, readDates, readList, runImport } from '../src/services/listImport.ts';

const ev = (id: string, patch: Partial<LoggedEvent>): LoggedEvent => ({
  id,
  input: patch.name ?? id,
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

const email = (id: string, patch: Partial<EmailImport>): EmailImport => ({
  id,
  key: id,
  status: 'new',
  seller: 'Ticketmaster',
  sources: {},
  messages: [],
  flags: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

// The shape of a Notion database export.
const NOTION = [
  'Event,Artist,Attendee,City,Date,Tags,Venue',
  'Spring Fest 2023,"Alpha, Beta","Sam, Lee",Las Vegas NV,"May 19, 2023 → May 21, 2023",,Speedway',
  'Echo Tour,Gamma,Sam,San Francisco CA,"October 7, 2017",,Auditorium',
  'Big Fest 2024,"Delta, Epsilon",Sam,Indio CA,"April 14, 2023 → April 16, 2023",,Polo Field',
  'Lost Fest 2022,"K?D, Zeta",Sam,Las Vegas NV,"September 30, 2022",,Event Center',
  'Some Fest 2025,"Eta, Theta",,,,,',
  'Echo Tour,"Gamma, Iota",Lee,,"October 7, 2017",,',
  'Mystery Night,Kappa,Sam,Oakland CA,sometime in 2019,,',
].join('\n');

test('parseCsv reads quoted cells, doubled quotes and newlines inside quotes', () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi""\nthere"\r\n1,2,3'), [
    ['a', 'b, c', 'say "hi"\nthere'],
    ['1', '2', '3'],
  ]);
  assert.deepEqual(parseCsv('﻿x,y\n'), [['x', 'y']]);
});

test('readDates reads Notion ranges and single dates, and nothing ambiguous', () => {
  assert.deepEqual(readDates('May 17, 2024 → May 19, 2024'), { startDate: '2024-05-17', endDate: '2024-05-19' });
  assert.deepEqual(readDates('May 22, 2022 → May 22, 2022'), { startDate: '2022-05-22', endDate: undefined });
  assert.deepEqual(readDates('2024-05-17 – 2024-05-19'), { startDate: '2024-05-17', endDate: '2024-05-19' });
  assert.deepEqual(readDates('7 Oct 2017'), { startDate: '2017-10-07', endDate: undefined });
  assert.deepEqual(readDates('05/06/2024'), { unread: '05/06/2024' });
  assert.deepEqual(readDates('February 30, 2024'), { unread: 'February 30, 2024' });
  assert.deepEqual(readDates(''), {});
});

test('readList maps Notion columns and reads each row without filling gaps', () => {
  const list = readList(NOTION);
  assert.equal(list.error, undefined);
  assert.deepEqual(
    list.columns.map((c) => c.field),
    ['name', 'seen', 'companions', 'city', 'startDate', null, 'venue'],
  );
  const fest = list.rows[0];
  assert.equal(fest.name, 'Spring Fest 2023');
  assert.equal(fest.startDate, '2023-05-19');
  assert.equal(fest.endDate, '2023-05-21');
  assert.equal(fest.city, 'Las Vegas');
  assert.equal(fest.region, 'NV', '"Las Vegas NV" is split into city and state');
  assert.equal(fest.country, undefined, 'the file gives no country; the server fills it from the state');
  assert.equal(fest.venue, 'Speedway');
  assert.deepEqual(fest.seen, ['Alpha', 'Beta']);
  assert.deepEqual(fest.companions, ['Sam', 'Lee']);
  assert.deepEqual(fest.problems, []);

  const undated = list.rows.find((r) => r.name === 'Some Fest 2025')!;
  assert.equal(undated.startDate, undefined);
  assert.equal(undated.year, 2025);
  assert.equal(undated.yearFromName, true);
  assert.equal(undated.venue, undefined);
  assert.equal(undated.city, undefined);
  assert.deepEqual(undated.problems, ['No date, only a year.']);
});

test('readList flags what looks wrong and fixes none of it', () => {
  const list = readList(NOTION);
  const big = list.rows.find((r) => r.name === 'Big Fest 2024')!;
  assert.equal(big.startDate, '2023-04-14');
  assert.ok(big.problems.includes('The name says 2024 but the date is in 2023.'));
  const lost = list.rows.find((r) => r.name === 'Lost Fest 2022')!;
  assert.deepEqual(lost.seen, ['K?D', 'Zeta']);
  assert.ok(lost.problems.some((p) => p.includes('"K?D" may have lost a character')));
  const mystery = list.rows.find((r) => r.name === 'Mystery Night')!;
  assert.equal(mystery.startDate, undefined);
  assert.equal(mystery.year, undefined);
  assert.ok(mystery.problems.includes('Couldn\'t read the date "sometime in 2019".'));
});

test('readList combines the same event listed twice', () => {
  const list = readList(NOTION);
  assert.equal(list.combined, 1);
  const echo = list.rows.filter((r) => r.name === 'Echo Tour');
  assert.equal(echo.length, 1);
  assert.deepEqual(echo[0].lines, [3, 7]);
  assert.deepEqual(echo[0].seen, ['Gamma', 'Iota']);
  assert.deepEqual(echo[0].companions, ['Sam', 'Lee']);
  assert.equal(echo[0].venue, 'Auditorium');
});

test('readList reads this app\'s own CSV export', () => {
  const list = readList(
    'Date,End date,Year,Event,Venue,City,Country,Saw,Went with,Rating,Ticket price,Notes\n' +
      '2024-05-17,2024-05-19,2024,Big Fest,Field,"Indio, CA",US,"Alpha, the Band; Beta",Sam; Lee,4,$120,Hot\n',
  );
  const row = list.rows[0];
  assert.deepEqual(row.seen, ['Alpha, the Band', 'Beta']);
  assert.deepEqual(row.companions, ['Sam', 'Lee']);
  assert.equal(row.city, 'Indio');
  assert.equal(row.region, 'CA');
  assert.equal(row.rating, 4);
  assert.equal(row.ticketPrice, 120);
  assert.equal(row.notes, 'Hot');
});

test('readList needs a name column', () => {
  assert.match(readList('Date,Venue\n2024-01-01,X').error!, /event name/);
});

test('findMatches: same date and containing name is the same event; another name on the same days only nearby', () => {
  const [fest] = readList(NOTION).rows;
  const events = [
    ev('a', { name: 'Spring Fest', startDate: '2023-05-19', endDate: '2023-05-21' }),
    ev('b', { name: 'Afterparty', startDate: '2023-05-20' }),
    ev('c', { name: 'Spring Fest', startDate: '2022-05-20' }),
  ];
  const m = findMatches(fest, events, []);
  assert.equal(m.exact?.kind === 'event' && m.exact.event.id, 'a');
  assert.deepEqual(
    m.nearby.map((t) => t.kind === 'event' && t.event.id),
    ['b'],
  );
});

test('findMatches looks at open email rows, not ones already linked or added', () => {
  const [fest] = readList(NOTION).rows;
  const rows = [
    email('linked', { name: 'Spring Fest 2023', startDate: '2023-05-19', eventId: 'x' }),
    email('added', { name: 'Spring Fest 2023', startDate: '2023-05-19', status: 'added' }),
    email('open', { name: 'Spring Fest Las Vegas 2023', startDate: '2023-05-19' }),
  ];
  const m = findMatches(fest, [], rows);
  assert.equal(m.exact, undefined);
  assert.deepEqual(
    m.nearby.map((t) => t.kind === 'email' && t.row.id),
    ['open'],
  );
  const exact = findMatches(fest, [], [email('same', { name: 'Spring Fest 2023', startDate: '2023-05-19', status: 'skipped' })]);
  assert.equal(exact.exact?.kind, 'email');
});

test('findMatches without dates needs the same name and year', () => {
  const undated = readList(NOTION).rows.find((r) => r.name === 'Some Fest 2025')!;
  assert.ok(findMatches(undated, [ev('a', { name: 'Some Fest 2025', year: 2025 })], []).exact);
  assert.equal(findMatches(undated, [ev('a', { name: 'Some Fest', year: 2025 })], []).exact, undefined);
});

test('fillPatch only fills empty fields and adds new acts and people', () => {
  const [fest] = readList(NOTION).rows;
  const base = ev('a', {
    name: 'Spring Fest',
    startDate: '2023-05-19',
    venue: 'Typed venue',
    seen: [{ key: 'alpha', name: 'ALPHA', from: 'lineup' }],
    companions: ['Lee'],
    rating: 5,
  });
  const { patch, adds } = fillPatch(fest, base, new Set(['sam']));
  assert.deepEqual(patch, {
    endDate: '2023-05-21',
    city: 'Las Vegas',
    region: 'NV',
    seen: [
      { name: 'ALPHA', from: 'lineup' },
      { name: 'Beta', from: 'you' },
    ],
  });
  assert.deepEqual(adds, ['end date', 'city', 'state', '1 act seen']);
  assert.equal(fillPatch(fest, { ...base, endDate: '2023-05-21', city: 'X', seen: [{ key: 'a', name: 'Alpha', from: 'you' }, { key: 'b', name: 'Beta', from: 'you' }], companions: ['Sam', 'Lee'] }).adds.length, 0);
});

test('newEventPatch sets every field from the file and clears what it lacks', () => {
  const undated = readList(NOTION).rows.find((r) => r.name === 'Some Fest 2025')!;
  const patch = newEventPatch(undated, new Set(['sam']));
  assert.equal(patch.name, 'Some Fest 2025');
  assert.equal(patch.startDate, null);
  assert.equal(patch.city, null);
  assert.equal(patch.venue, null);
  assert.equal(patch.year, 2025);
  assert.deepEqual(patch.seen, [
    { name: 'Eta', from: 'you' },
    { name: 'Theta', from: 'you' },
  ]);
  const [fest] = readList(NOTION).rows;
  assert.deepEqual(newEventPatch(fest, new Set(['sam'])).companions, ['Lee']);
});

function fakeApi(events: LoggedEvent[], emails: EmailImport[]) {
  const calls: string[] = [];
  const store = new Map(events.map((e) => [e.id, e]));
  let n = 0;
  const api: ImportApi = {
    async create(text) {
      calls.push(`create ${text}`);
      const e = ev(`new${++n}`, { name: text });
      store.set(e.id, e);
      return e;
    },
    async update(id, patch: EventPatch) {
      calls.push(`update ${id} ${Object.keys(patch).join(',')}`);
      const e = store.get(id)!;
      const next = { ...e, ...(patch as Partial<LoggedEvent>) } as LoggedEvent;
      store.set(id, next);
      return next;
    },
    async addEmail(ids) {
      calls.push(`add ${ids.join(',')}`);
      const row = emails.find((r) => r.id === ids[0])!;
      if (row.status !== 'new') return { events: [], imports: [] };
      row.status = 'added';
      const e = ev(`email-${row.id}`, { name: row.name!, startDate: row.startDate, venue: row.venue });
      store.set(e.id, e);
      return { events: [e], imports: [row] };
    },
    async restoreEmail(ids) {
      calls.push(`restore ${ids.join(',')}`);
      for (const r of emails) if (ids.includes(r.id)) r.status = 'new';
    },
  };
  return { api, calls, store };
}

test('runImport creates, merges, adds email rows first, and builds on earlier merges', async () => {
  const rows = readList(NOTION).rows;
  const fest = rows[0];
  const echo = rows.find((r) => r.name === 'Echo Tour')!;
  const lost = rows.find((r) => r.name === 'Lost Fest 2022')!;
  const logged = ev('logged', { name: 'Echo Tour', startDate: '2017-10-07', seen: [{ key: 'gamma', name: 'Gamma', from: 'you' }] });
  const mail = email('mail', { name: 'Spring Fest Las Vegas 2023', startDate: '2023-05-19', venue: 'Speedway', status: 'skipped' });
  const { api, calls, store } = fakeApi([logged], [mail]);
  const result = await runImport(
    [
      { row: fest, choice: { kind: 'into', target: { kind: 'email', row: mail } } },
      { row: echo, choice: { kind: 'into', target: { kind: 'event', event: logged } } },
      { row: { ...echo, seen: ['Lambda'] }, choice: { kind: 'into', target: { kind: 'event', event: logged } } },
      { row: lost, choice: { kind: 'new' } },
      { row: rows[2], choice: { kind: 'skip' } },
    ],
    api,
    new Set(['sam']),
  );
  assert.deepEqual(result, { created: 1, merged: 3, edited: 0, unchanged: 0, failed: [] });
  assert.deepEqual(calls.slice(0, 3), ['restore mail', 'add mail', 'update email-mail endDate,city,region,seen,companions']);
  assert.equal(store.get('email-mail')!.venue, 'Speedway');
  assert.deepEqual(
    store.get('logged')!.seen.map((s) => s.name),
    ['Gamma', 'Iota', 'Lambda'],
  );
  assert.deepEqual(store.get('logged')!.companions, ['Lee']);
  assert.equal(calls[calls.length - 2], 'create Lost Fest 2022');
  const created = store.get('new1')!;
  assert.equal(created.city, 'Las Vegas');
  assert.deepEqual(created.companions, []);
});

test('runImport reports a failed row and goes on', async () => {
  const rows = readList(NOTION).rows;
  const mail = email('mail', { name: 'Spring Fest 2023', startDate: '2023-05-19', status: 'added' });
  const { api } = fakeApi([], [mail]);
  const result = await runImport(
    [
      { row: rows[0], choice: { kind: 'into', target: { kind: 'email', row: mail } } },
      { row: rows[1], choice: { kind: 'new' } },
    ],
    api,
  );
  assert.equal(result.created, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /could not be added/);
});
