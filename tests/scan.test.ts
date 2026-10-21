import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { GmailApi, GmailAuthError, GmailMessage, messageBodies, toMessage } from '../src/server/events/email/gmail.ts';
import { mergeImports, readEmails } from '../src/server/events/email/imports.ts';
import { forwardQuery, GMAIL_SETTING, SCAN_SETTING, ScanSetting, scanStep, senderQuery } from '../src/server/events/email/scan.ts';
import { importsRouter } from '../src/server/events/importRoutes.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-20T12:00:00Z');

const dice = (id: string, name: string, sentAt: string): GmailMessage => ({
  id,
  link: `https://mail.google.com/mail/?authuser=0#all/${id}`,
  from: 'DICE <hello@dice.fm>',
  subject: `Your tickets: ${name}`,
  sentAt,
  receivedAt: Date.parse(sentAt),
  text: `Venue details\nVenue\nLos Globos\n3040 Sunset Blvd, Los Angeles, CA 90026, USA\nDate & time\nSat 17 Oct,10:00 PM GMT-7\nTickets\n1 x General Admission\nTotal\n$25.00`,
});

const newsletter = (id: string, sentAt: string): GmailMessage => ({
  id,
  link: '',
  from: 'DICE <hello@dice.fm>',
  subject: 'This week in Los Angeles',
  sentAt,
  receivedAt: Date.parse(sentAt),
  text: 'Shows we think you will like',
});

// A Gmail inbox: honours `after:` like Gmail does and lists newest first.
function fakeGmail(mail: GmailMessage[]) {
  const queries: string[] = [];
  const reads: string[] = [];
  const api: GmailApi = {
    authUrl: (redirect, state) => `https://accounts.example/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${state}`,
    connect: async (code) => {
      if (code !== 'good-code') throw new GmailAuthError('bad code');
      return { refreshToken: 'refresh-1', account: 'me@example.com' };
    },
    listIds: async (_token, query) => {
      queries.push(query);
      const after = Number(query.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      const forwards = query.startsWith('subject:(fwd');
      return mail
        .filter((m) => m.receivedAt > after && (forwards ? /^fwd?:/i.test(m.subject) : !/@gmail\.com/.test(m.from)))
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .map((m) => m.id);
    },
    getMessage: async (_token, id) => {
      reads.push(id);
      return mail.find((m) => m.id === id)!;
    },
  };
  return { api, queries, reads, mail };
}

const newStore = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'scan-')));
const connect = (store: FileLineupStore) => store.putSetting(GMAIL_SETTING, { refreshToken: 'refresh-1', connectedAt: NOW.toISOString() });

test('senderQuery: one search over every seller that has a reader', () => {
  const q = senderQuery();
  for (const domain of ['ticketmaster.com', 'tixr.com', 'dice.fm', 'ra.co', 'eventbrite.com', 'axs.com', 'frontgatetickets.com']) {
    assert.ok(q.includes(domain), domain);
  }
  assert.match(q, /^from:\(.+ OR .+\)$/);
});

test('scanStep: starts after the newest email already imported, reads oldest first in batches, then stops', async () => {
  const store = await newStore();
  await connect(store);
  // The back-fill already read old-1.
  const old = dice('old-1', 'OLD SHOW', '2026-09-01T10:00:00Z');
  await store.putImports(mergeImports([], readEmails([old]).outcomes, [], NOW));
  const gmail = fakeGmail([
    old,
    dice('n1', 'FIRST', '2026-09-10T10:00:00Z'),
    newsletter('n2', '2026-09-11T10:00:00Z'),
    dice('n3', 'THIRD', '2026-09-12T10:00:00Z'),
  ]);

  const first = await scanStep(store, gmail.api, NOW, 2);
  assert.match(gmail.queries[0], /after:\d+$/);
  assert.equal(Number(gmail.queries[0].match(/after:(\d+)/)![1]) * 1000, Date.parse('2026-08-31T10:00:00Z')); // a day's lookback
  assert.deepEqual(gmail.reads, ['n1', 'n2']);
  assert.deepEqual({ read: first.read, remaining: first.remaining, added: first.added }, { read: 2, remaining: 1, added: 1 });
  assert.equal(first.lastCheckedAt, undefined);

  const second = await scanStep(store, gmail.api, NOW, 2);
  assert.deepEqual(gmail.reads, ['n1', 'n2', 'n3']);
  assert.deepEqual({ read: second.read, remaining: second.remaining, added: second.added }, { read: 1, remaining: 0, added: 1 });
  assert.equal(second.lastCheckedAt, NOW.toISOString());
  assert.equal(second.scannedThrough, '2026-09-12T10:00:00.000Z');

  // Nothing new: the newsletter is not read again, and no row was added for it.
  const third = await scanStep(store, gmail.api, NOW, 2);
  assert.deepEqual({ read: third.read, remaining: third.remaining, added: third.added }, { read: 0, remaining: 0, added: 0 });
  assert.equal(gmail.reads.length, 3);
  const names = (await store.listImports()).map((r) => r.name).sort();
  assert.deepEqual(names, ['FIRST', 'OLD SHOW', 'THIRD']);
  assert.ok((await store.listImports()).every((r) => r.status === 'new' && !r.eventId));

  // Mail arriving later is picked up by the next check.
  gmail.mail.push(dice('n4', 'LATER', '2026-10-19T10:00:00Z'));
  const fourth = await scanStep(store, gmail.api, NOW, 2);
  assert.deepEqual(gmail.reads.slice(3), ['n4']);
  assert.equal(fourth.added, 1);
  const state = (await store.getSetting<ScanSetting>(SCAN_SETTING))!;
  assert.deepEqual(Object.keys(state.recent), ['n4']); // older ids fall out once outside the lookback
});

test('scanStep: forwards are searched through all past mail once, then like the rest', async () => {
  const store = await newStore();
  await connect(store);
  // Checked before forwards were searched: only the sellers' cursor exists.
  await store.putSetting<ScanSetting>(SCAN_SETTING, { scannedThrough: '2026-10-01T00:00:00.000Z', lastCheckedAt: NOW.toISOString(), recent: {} });
  const forwarded = (id: string, name: string, forwardedAt: string, sentAt: string): GmailMessage => ({
    ...dice(id, name, forwardedAt),
    from: 'Justin <jcho49@gmail.com>',
    subject: `Fwd: Your tickets: ${name}`,
    text: `---------- Forwarded message ---------\nFrom: DICE <hello@dice.fm>\nDate: ${sentAt}\nSubject: Your tickets: ${name}\nTo: <jcho49@gmail.com>\n\n${dice(id, name, forwardedAt).text}`,
  });
  // Forwarded after the show: read from the forward's own date, "Sat 17 Oct"
  // would have no year (Oct 17, 2027 is a Sunday).
  const gmail = fakeGmail([forwarded('f1', 'OLD FORWARD', '2026-10-19T10:00:00Z', 'Tue, Sep 1, 2026 at 9:00 AM'), dice('d1', 'NEW', '2026-10-10T10:00:00Z')]);

  assert.match(forwardQuery(), /^subject:\(fwd OR fw\) -from:me \(.*dice\.fm/);
  const step = await scanStep(store, gmail.api, NOW);
  assert.deepEqual(gmail.queries.map((q) => q.includes('after:')), [true, false]);
  assert.deepEqual(gmail.reads.sort(), ['d1']); // the sellers' mail first
  assert.equal(step.remaining, 1);
  const next = await scanStep(store, gmail.api, NOW);
  assert.deepEqual(gmail.reads, ['d1', 'f1']);
  assert.equal(next.remaining, 0);
  const rows = await store.listImports();
  const old = rows.find((r) => r.name === 'OLD FORWARD')!;
  assert.equal(old.seller, 'DICE');
  assert.equal(old.startDate, '2026-10-17');
  assert.equal(old.status, 'new');

  // The next check searches forwards only from the newest one read.
  await scanStep(store, gmail.api, NOW);
  assert.match(gmail.queries[gmail.queries.length - 1], /after:\d+$/);
});

test('scanStep: needs Gmail connected', async () => {
  const store = await newStore();
  await assert.rejects(scanStep(store, fakeGmail([]).api, NOW), /Connect Gmail/);
});

test('messageBodies: decodes the html and text parts of a multipart message', () => {
  const b64 = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64('Café ✓') } },
          { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=iso-8859-1' }], body: { data: b64('<p>Caf\xe9</p>', 'latin1') } },
        ],
      },
      { mimeType: 'application/pdf', body: {} },
    ],
  };
  assert.deepEqual(messageBodies(payload), { text: 'Café ✓', html: '<p>Café</p>' });

  const message = toMessage(
    { id: 'abc', internalDate: String(Date.parse('2026-10-01T00:00:00Z')), payload: { ...payload, headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'x@dice.fm' }] } },
    'me@example.com',
  );
  assert.equal(message.sentAt, '2026-10-01T00:00:00.000Z');
  assert.equal(message.subject, 'Hi');
  assert.equal(message.link, 'https://mail.google.com/mail/?authuser=me%40example.com#all/abc');
});

async function server(t: { after: (fn: () => void) => void }, gmail: GmailApi | null) {
  const store = await newStore();
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
  const app = express();
  app.use(express.json());
  app.use('/api', importsRouter(deps, gmail));
  const listening = app.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => listening.close());
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api`;
  const call = (route: string, method = 'GET') => fetch(`${base}${route}`, { method, redirect: 'manual' });
  return { store, call };
}

test('scan routes: off without Google keys', async (t) => {
  const { call } = await server(t, null);
  assert.deepEqual(await (await call('/imports/scan')).json(), { configured: false, connected: false });
  assert.equal((await call('/imports/scan', 'POST')).status, 503);
  assert.equal((await call('/gmail/connect')).status, 503);
});

test('scan routes: connect checks the sign-in state, then checking reads new mail', async (t) => {
  const gmail = fakeGmail([dice('n1', 'FIRST', '2026-10-10T10:00:00Z')]);
  const { store, call } = await server(t, gmail.api);

  assert.deepEqual(await (await call('/imports/scan')).json(), { configured: true, connected: false });
  const notYet = await call('/imports/scan', 'POST');
  assert.equal(notYet.status, 409);
  assert.equal((await notYet.json()).connect, true);

  // A callback that did not start here is refused.
  const forged = await call('/gmail/callback?code=good-code&state=made-up');
  assert.match(forged.headers.get('location')!, /^\/\?gmail=That%20sign-in%20expired/);
  assert.equal(await store.getSetting(GMAIL_SETTING), null);

  const start = await call('/gmail/connect');
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const done = await call(`/gmail/callback?code=good-code&state=${state}`);
  assert.equal(done.headers.get('location'), '/?gmail=connected');
  // The state works once.
  const replay = await call(`/gmail/callback?code=good-code&state=${state}`);
  assert.match(replay.headers.get('location')!, /expired/);

  const status = await (await call('/imports/scan')).json();
  assert.equal(status.connected, true);
  assert.equal(status.account, 'me@example.com');

  const step = await (await call('/imports/scan', 'POST')).json();
  assert.deepEqual({ read: step.read, remaining: step.remaining, added: step.added }, { read: 1, remaining: 0, added: 1 });
  assert.deepEqual(await store.listEvents(), []);
});
