import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';

// The guard runs before the store is touched, so a stub store is enough for
// the 403 path. Each request runs as the given member (via the request scope).
async function withApp(member: { role: string; uid: string }, fn: (base: string) => Promise<void>) {
  const store: any = new Proxy({}, { get: () => () => { throw new Error('store should not be reached for members'); } });
  const app = express();
  app.use((_req, _res, next) => runAsMember(member as any, store, next));
  app.use('/api', entitiesRouter({ store } as any));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

for (const path of ['/api/manage/canonical/editions', '/api/manage/canonical/artists']) {
  test(`member gets 403 on ${path}`, async () => {
    await withApp({ role: 'member', uid: 'u1' }, async (base) => {
      const res = await fetch(base + path);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /Only the owner/);
    });
  });
}
