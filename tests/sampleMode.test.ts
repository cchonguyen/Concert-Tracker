import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessRequestsApi, eventsApi } from '../src/services/lineupApi.ts';
import { activateSample, reportBlockedWrite, SAMPLE_WRITE_MESSAGE, SampleRefused, setBlockedWriteHandler, startMode } from '../src/services/sampleMode.ts';
import { sampleEvents } from '../src/demo/sampleData.ts';

const me = { multiUser: true, role: 'member' as const, email: null };
const network = () => Promise.reject(new TypeError('Failed to fetch'));
const serverError = () => Promise.reject(Object.assign(new Error('Server is not configured'), { code: undefined }));

// Stands in for the browser: the page's window and the global fetch both count what reaches the network.
function stubBrowser() {
  const calls: string[] = [];
  const realFetch = async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ state: 'none' });
  };
  (globalThis as { window?: unknown }).window = { fetch: realFetch };
  globalThis.fetch = realFetch as typeof fetch;
  return calls;
}

test('/demo is sample mode with no server call', async () => {
  let asked = false;
  const start = await startMode('/demo', async () => {
    asked = true;
    return me;
  });
  assert.deepEqual(start, { kind: 'sample', mode: 'demo', email: null });
  assert.equal(asked, false);
});

test('a member on /app gets the archive', async () => {
  assert.deepEqual(await startMode('/app', async () => me), { kind: 'member', me });
});

test('a network error or a 5xx never enters sample mode', async () => {
  for (const failing of [network, serverError]) {
    assert.equal((await startMode('/app', failing)).kind, 'error');
  }
});

test('an explicit not_invited answer enters sample mode with the verified email', async () => {
  const start = await startMode('/app', () => Promise.reject(Object.assign(new Error('not invited'), { code: 'not_invited', email: 'you@gmail.com' })));
  assert.deepEqual(start, { kind: 'sample', mode: 'not-invited', email: 'you@gmail.com' });
});

test('sample mode answers reads locally, refuses writes, and never reaches the network', async () => {
  const calls = stubBrowser();
  let blocked = 0;
  setBlockedWriteHandler(() => {
    blocked += 1;
  });

  await activateSample({ mode: 'demo', email: null });

  const { events, lineups } = await eventsApi.list();
  assert.equal(events.length, sampleEvents.length);
  assert.ok(Object.keys(lineups).length > 0);
  assert.equal((await eventsApi.get(sampleEvents[0].id)).event.id, sampleEvents[0].id);
  await assert.rejects(eventsApi.get('not-in-sample'), SampleRefused);

  await assert.rejects(eventsApi.create('Portola 2025'), (err: unknown) => err instanceof SampleRefused && err.message === SAMPLE_WRITE_MESSAGE);
  assert.equal(blocked, 1, 'a refused write opens the explainer once');
  await assert.rejects(eventsApi.remove(sampleEvents[0].id), SampleRefused);
  assert.equal(blocked, 2);

  // The guard behind the API client: a direct call to /api fails, while a page asset still loads.
  await assert.rejects(window.fetch('/api/members'), SampleRefused);
  assert.equal((await window.fetch('/assets/app.js')).status, 200);
  assert.deepEqual(calls, ['/assets/app.js'], 'only the asset reached the network');

  setBlockedWriteHandler(null);
  reportBlockedWrite();
  assert.equal(blocked, 2, 'with no explainer registered, a refused write is still refused');
});

test('a stranger in sample mode may make only the request-access calls', async () => {
  const calls = stubBrowser();
  await activateSample({ mode: 'not-invited', email: 'you@gmail.com' });

  assert.equal((await accessRequestsApi.mine()).state, 'none');
  assert.deepEqual(calls, ['/api/access-requests/mine']);

  await assert.rejects(accessRequestsApi.list(), SampleRefused, 'the owner list is not in the sample');
  await assert.rejects(window.fetch('/api/members'), SampleRefused);
  assert.deepEqual(calls, ['/api/access-requests/mine'], 'nothing else reached the network');
});
