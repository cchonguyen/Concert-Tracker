import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanGmailInBrowser, GmailTokenError } from '../src/gmailClient.ts';
import { STREAM_A_QUERY } from '../src/queries.ts';
import { buildCorpus } from './fixtures/corpus.ts';

// A fake Gmail that serves corpus messages, so the client is tested end to
// end without a network.

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_');

function fakeGmail(emails: ReturnType<typeof buildCorpus>[number]['email'][], seen: string[] = []) {
  const byId = new Map(emails.map((e) => [e.id, e]));
  return (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const list = url.match(/\/messages\?.*q=([^&]*)/);
    if (list) {
      const q = decodeURIComponent(list[1]);
      return json({ messages: q.startsWith('from:') ? emails.map((e) => ({ id: e.id })) : [] });
    }
    const one = url.match(/\/messages\/([^?/]+)\?format=full/);
    const e = one && byId.get(one[1]);
    if (!e) return new Response('{}', { status: 404 });
    const parts = [e.html && { mimeType: 'text/html', body: { data: b64url(e.html) } }, e.text && { mimeType: 'text/plain', body: { data: b64url(e.text) } }].filter(Boolean);
    return json({
      id: e.id,
      internalDate: String(Date.parse(e.sentAt)),
      payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: e.from }, { name: 'Subject', value: e.subject }], parts },
    });
  }) as typeof fetch;
}

const tier1 = buildCorpus().filter((f) => f.group === 'tier1' && f.expect).slice(0, 6);

test('gmail client: reads listed mail into proposals, reports progress and moves the cursor', async () => {
  const steps: number[] = [];
  const result = await scanGmailInBrowser({
    token: 't',
    fetch: fakeGmail(tier1.map((f) => f.email)),
    onProgress: (p) => p.phase === 'reading' && steps.push(p.examined),
  });
  assert.equal(result.examined, tier1.length);
  assert.ok(result.summary.proposals >= tier1.length - 1);
  assert.equal(steps.length, tier1.length);
  assert.equal(Math.max(...steps), tier1.length);
  const newest = tier1.map((f) => new Date(f.email.sentAt).toISOString()).sort().pop();
  assert.equal(result.updatedCursors.streamA, newest);
});

test('gmail client: ignoreCursors searches all mail; a cursor narrows the search', async () => {
  const seen: string[] = [];
  const gmail = fakeGmail(tier1.map((f) => f.email), seen);
  await scanGmailInBrowser({ token: 't', fetch: gmail, cursors: { streamA: '2024-05-01T00:00:00.000Z' } });
  assert.ok(seen.some((u) => decodeURIComponent(u).includes('after:2024/05/01')));
  seen.length = 0;
  await scanGmailInBrowser({ token: 't', fetch: gmail, cursors: { streamA: '2024-05-01T00:00:00.000Z' }, ignoreCursors: true });
  const lists = seen.filter((u) => u.includes('q=')).map((u) => decodeURIComponent(u));
  assert.ok(lists.every((u) => !u.includes('after:')));
  assert.ok(lists.some((u) => u.includes(STREAM_A_QUERY)));
});

test('gmail client: an expired token stops the scan', async () => {
  const gmail = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  await assert.rejects(scanGmailInBrowser({ token: 't', fetch: gmail }), GmailTokenError);
});
