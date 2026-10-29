import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanGmailInBrowser, scanReportCsv } from '../src/gmailClient.ts';
import { scanEmails } from '../src/scan.ts';
import { STREAM_A_QUERY } from '../src/queries.ts';
import type { EmailImportProposal, RawEmailMessage } from '../src/types.ts';
import { buildCorpus } from './fixtures/corpus.ts';

// The zero-cursor diagnostic harness: the whole 100-message corpus read through
// the browser scan path (list both streams, fetch each message, read it in
// memory) from empty cursors, as a first scan or a "Full re-scan" does. It
// checks that this path reads every message once, finds what the engine finds
// when handed the same mail directly, reports counts that add up, and keeps
// the token out of everything it returns.

const corpus = buildCorpus();
const emails = corpus.map((f) => f.email);
const TOKEN = 'ya29.harness-token-never-stored';
const PAGE = 30;

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_');
const toUrlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');
const sellerDomains = STREAM_A_QUERY.slice('from:('.length, -1).split(' OR ');

// A fake Gmail with both streams, pages and `after:` filtering. Stream A
// lists mail from known sellers; Stream B lists every message, so the two
// overlap the way forwards and wallet passes do in a real inbox.
function fakeGmail(seen: Array<{ url: string; auth: string }>) {
  const byId = new Map(emails.map((e) => [e.id, e]));
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const list = url.match(/\/messages\?(.*)$/);
    if (list) {
      const params = new URLSearchParams(list[1]);
      const q = params.get('q') ?? '';
      const after = q.match(/after:(\d{4})\/(\d{2})\/(\d{2})/);
      const since = after ? `${after[1]}-${after[2]}-${after[3]}` : '';
      const hits = emails
        .filter((e) => !q.startsWith('from:') || sellerDomains.some((d) => e.from.toLowerCase().includes(d)))
        .filter((e) => e.sentAt.slice(0, 10) >= since)
        .map((e) => ({ id: e.id }));
      const at = Number(params.get('pageToken') || 0);
      const next = at + PAGE < hits.length ? String(at + PAGE) : undefined;
      return json({ messages: hits.slice(at, at + PAGE), nextPageToken: next });
    }
    const one = url.match(/\/messages\/([^?/]+)\?format=full/);
    const e = one && byId.get(one[1]);
    if (!e) return new Response('{}', { status: 404 });
    const parts = [
      e.html && { mimeType: 'text/html', body: { data: b64url(e.html) } },
      e.text && { mimeType: 'text/plain', body: { data: b64url(e.text) } },
      ...(e.attachments ?? []).map((a) => ({ filename: a.filename, mimeType: a.mimeType, body: { data: toUrlSafe(a.dataBase64) } })),
    ].filter(Boolean);
    const headers = [{ name: 'From', value: e.from }, { name: 'Subject', value: e.subject }, ...(e.to ? [{ name: 'To', value: e.to }] : [])];
    return json({ id: e.id, threadId: e.threadId, internalDate: String(Date.parse(e.sentAt)), payload: { mimeType: 'multipart/mixed', headers, parts } });
  }) as typeof fetch;
}

async function zeroScan(options: { cursors?: { streamA?: string; streamB?: string }; ignoreCursors?: boolean } = {}) {
  const seen: Array<{ url: string; auth: string }> = [];
  const result = await scanGmailInBrowser({ token: TOKEN, fetch: fakeGmail(seen), ...options });
  return { result, seen };
}

// What a reviewer sees of a proposal, without ids that depend on read order.
const view = (p: EmailImportProposal) => ({
  status: p.status,
  seller: p.seller,
  name: p.name?.value,
  date: p.date?.value,
  venue: p.venue?.value,
  city: p.city?.value,
  price: p.ticketPrice?.amount,
  flags: p.flags.map((f) => f.kind),
  links: [...p.messageLinks].sort(),
});
const byKey = (a: ReturnType<typeof view>, b: ReturnType<typeof view>) => JSON.stringify(a).localeCompare(JSON.stringify(b));

const zero = await zeroScan();

test('zero cursor: every message is listed without a date bound and read exactly once', () => {
  const lists = zero.seen.filter((s) => s.url.includes('/messages?')).map((s) => decodeURIComponent(s.url));
  assert.ok(lists.every((u) => !u.includes('after:')));
  assert.ok(lists.some((u) => u.includes('pageToken=')), 'listing should page past the first page');
  const reads = zero.seen.filter((s) => s.url.includes('format=full')).map((s) => s.url);
  assert.equal(new Set(reads).size, reads.length, 'a message in both streams is fetched once');
  assert.equal(zero.result.examined, emails.length);
  assert.deepEqual(zero.result.failed, []);
  assert.deepEqual(new Set(zero.result.messages.map((m) => m.id)), new Set(emails.map((e) => e.id)));
});

test('zero cursor: the browser path finds what the engine finds from the same mail', async () => {
  const direct = await scanEmails([...emails].sort((a, b) => a.sentAt.localeCompare(b.sentAt)));
  assert.deepEqual(zero.result.proposals.map(view).sort(byKey), direct.map(view).sort(byKey));
});

test('zero cursor: the report counts add up and traps produce no show', () => {
  const s = zero.result.summary;
  const count = (status: EmailImportProposal['status']) => zero.result.proposals.filter((p) => p.status === status).length;
  assert.equal(s.examined, emails.length);
  assert.equal(s.proposals, count('new'));
  assert.equal(s.unreadable.length, count('unreadable'));
  assert.equal(s.skipped, count('skipped'));
  assert.equal(s.proposals + s.unreadable.length + s.skipped + count('flag'), zero.result.proposals.length);
  assert.equal(Object.values(s.bySeller).reduce((a, b) => a + b, 0), s.proposals);
  assert.ok(s.netUniqueEvents <= s.proposals);
  const traps = new Set(corpus.filter((f) => !f.expect).map((f) => f.email.link));
  const trapShows = zero.result.proposals.filter((p) => (p.status === 'new' || p.status === 'flag') && p.messageLinks.some((l) => traps.has(l)));
  assert.deepEqual(trapShows.map((p) => p.name?.value), []);
  const csv = scanReportCsv(zero.result.proposals, zero.result.messages).trim().split('\n');
  assert.equal(csv.length, zero.result.proposals.length + 1);
});

test('zero cursor: the cursors land on each stream\'s newest message', () => {
  const newest = (list: RawEmailMessage[]) => list.map((e) => new Date(e.sentAt).toISOString()).sort().pop();
  const fromSellers = emails.filter((e) => sellerDomains.some((d) => e.from.toLowerCase().includes(d)));
  const onlyB = emails.filter((e) => !fromSellers.includes(e));
  assert.equal(zero.result.updatedCursors.streamA, newest(fromSellers));
  assert.equal(zero.result.updatedCursors.streamB, newest(onlyB));
});

test('zero cursor: a full re-scan from saved cursors gives the same report as a first scan', async () => {
  const { result } = await zeroScan({ cursors: zero.result.updatedCursors, ignoreCursors: true });
  assert.deepEqual(result.summary, zero.result.summary);
  assert.deepEqual(result.proposals.map(view).sort(byKey), zero.result.proposals.map(view).sort(byKey));
});

test('zero cursor: a check after the first scan reads only mail from the cursor day on', async () => {
  const cursors = zero.result.updatedCursors;
  const { result, seen } = await zeroScan({ cursors });
  const lists = seen.filter((s) => s.url.includes('/messages?')).map((s) => decodeURIComponent(s.url));
  assert.ok(lists.every((u) => u.includes('after:')));
  assert.ok(result.examined < emails.length);
  const earliest = [cursors.streamA!, cursors.streamB!].sort()[0].slice(0, 10);
  assert.ok(result.messages.every((m) => m.sentAt.slice(0, 10) >= earliest));
});

test('zero cursor: the token goes only to Gmail, only in the Authorization header', () => {
  for (const s of zero.seen) {
    assert.equal(new URL(s.url).host, 'gmail.googleapis.com');
    assert.ok(!s.url.includes(TOKEN));
    assert.equal(s.auth, `Bearer ${TOKEN}`);
  }
  assert.ok(!JSON.stringify(zero.result).includes(TOKEN));
  assert.ok(!scanReportCsv(zero.result.proposals, zero.result.messages).includes(TOKEN));
});
