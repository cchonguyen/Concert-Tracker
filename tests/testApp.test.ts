import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get('/ok', (_req, res) => {
    res.status(200).json({ hello: 'world', n: 2 });
  });
  app.get('/echo-header', (req, res) => {
    res.setHeader('x-echo', String(req.headers['x-probe'] ?? ''));
    res.send('done');
  });
  app.get('/two-cookies', (_req, res) => {
    res.append('Set-Cookie', 'a=1; Path=/');
    res.append('Set-Cookie', 'b=2; Path=/');
    res.send('cookies');
  });
  app.post('/body', (req, res) => {
    res.json({ got: req.body });
  });
  app.get('/boom', () => {
    throw Object.assign(new Error('bad input'), { status: 400 });
  });
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

test('a status code comes back from the app', async () => {
  const res = await dispatch(makeApp(), { url: '/ok' });
  assert.equal(res.status, 200);
});

test('a JSON body is read with json()', async () => {
  const res = await dispatch(makeApp(), { url: '/ok' });
  assert.deepEqual(res.json(), { hello: 'world', n: 2 });
  assert.equal(res.text(), '{"hello":"world","n":2}');
});

test('a request header round-trips through the app', async () => {
  const res = await dispatch(makeApp(), { url: '/echo-header', headers: { 'X-Probe': 'marker-42' } });
  assert.equal(res.headers.get('x-echo'), 'marker-42');
  assert.equal(res.body, 'done');
});

test('two set-cookie values are both read with getSetCookie()', async () => {
  const res = await dispatch(makeApp(), { url: '/two-cookies' });
  assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
});

test('a JSON request body reaches the app as an object', async () => {
  const res = await dispatch(makeApp(), { method: 'post', url: '/body', body: { name: 'x' } });
  assert.deepEqual(res.json(), { got: { name: 'x' } });
});

test('an unknown route is a 404', async () => {
  const res = await dispatch(makeApp(), { url: '/missing' });
  assert.equal(res.status, 404);
});

test('a thrown error is routed through the app error middleware', async () => {
  const res = await dispatch(makeApp(), { url: '/boom' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json(), { error: 'bad input' });
});

test('this file opens no socket: it never calls listen', () => {
  const source = readFileSync(new URL('./testApp.test.ts', import.meta.url), 'utf8');
  assert.equal(/\.listen\(/.test(source), false);
});
