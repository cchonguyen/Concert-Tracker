import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { brandsApi } from '../src/services/brandsApi.ts';

type Call = { url: string; method: string; body: unknown };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

function stubFetch() {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('list reads the owner brand route and returns the brands', async () => {
  stubFetch();
  reply = { status: 200, body: { brands: [{ id: 'b1', name: 'EDC', aliases: [], organizationId: null }] } };
  const rows = await brandsApi.list();
  assert.equal(calls[0].url, '/api/manage/brands');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(rows.map((r) => r.name), ['EDC']);
});

test('rename, organization, merge and undo post to the matching routes', async () => {
  stubFetch();
  reply = { status: 200, body: { id: 'h1', operation: 'rename', brandId: 'b1', mergedFromId: null, undoneAt: null } };
  await brandsApi.rename('b1', 'Electric Daisy Carnival');
  await brandsApi.setOrganization('b1', null);
  await brandsApi.merge('b2', 'b1');
  await brandsApi.undo('h1');
  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ['PATCH', '/api/manage/brands/b1'],
      ['PATCH', '/api/manage/brands/b1/organization'],
      ['POST', '/api/manage/brands/merge'],
      ['POST', '/api/manage/brands/history/h1/undo'],
    ],
  );
  assert.deepEqual(calls[0].body, { name: 'Electric Daisy Carnival' });
  assert.deepEqual(calls[1].body, { organizationId: null });
  assert.deepEqual(calls[2].body, { sourceId: 'b2', targetId: 'b1' });
});

test('a refused change throws the server message', async () => {
  stubFetch();
  reply = { status: 409, body: { error: 'Another brand already has that name.' } };
  await assert.rejects(() => brandsApi.rename('b1', 'EDC'), { message: 'Another brand already has that name.' });
});
