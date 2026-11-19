import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askToken, loadGis, resetGisLoaderForTests } from '../src/components/BrowserScan.tsx';

function withDom<T>(fn: (state: { window: Record<string, any>; appended: any[] }) => Promise<T> | T): Promise<T> {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const appended: any[] = [];
  const win: Record<string, any> = {};
  const doc = {
    querySelector: () => null,
    createElement: (tag: string) => ({
      tagName: tag.toUpperCase(),
      src: '',
      async: false,
      onload: null as null | (() => void),
      onerror: null as null | (() => void),
      remove: () => undefined,
    }),
    head: {
      appendChild: (el: any) => {
        appended.push(el);
        return el;
      },
    },
  };
  (globalThis as any).window = win;
  (globalThis as any).document = doc;
  resetGisLoaderForTests();
  return Promise.resolve()
    .then(() => fn({ window: win, appended }))
    .finally(() => {
      resetGisLoaderForTests();
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
      if (prevDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDocument;
    });
}

test('loadGis deduplicates concurrent loads and clears cache on error for retry', async () => {
  await withDom(async ({ window, appended }) => {
    const p1 = loadGis();
    const p2 = loadGis();
    assert.equal(p1, p2);
    assert.equal(appended.length, 1);

    appended[0].onerror();
    await assert.rejects(p1, /Could not load Google sign-in/);

    const p3 = loadGis();
    assert.equal(appended.length, 2);
    window.google = { accounts: { oauth2: { initTokenClient: () => ({}) } } };
    appended[1].onload();
    const loaded = await p3;
    assert.equal(loaded, window.google);
  });
});

test('askToken triggers requestAccessToken synchronously when GIS is already preloaded', async () => {
  await withDom(async ({ window }) => {
    let requestedSync = false;
    let savedCallbacks: { callback: (r: any) => void; error_callback: (e: any) => void } | null = null;
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: any) => {
            savedCallbacks = { callback: cfg.callback, error_callback: cfg.error_callback };
            return {
              requestAccessToken: (opts: any) => {
                assert.deepEqual(opts, { prompt: '' });
                requestedSync = true;
              },
            };
          },
        },
      },
    };

    const tokenPromise = askToken('test-client-id');
    assert.equal(requestedSync, true, 'popup request must fire synchronously inside user click handler');
    savedCallbacks!.callback({ access_token: 'tok-123' });
    assert.equal(await tokenPromise, 'tok-123');

    const errPromise = askToken('test-client-id');
    savedCallbacks!.error_callback({ message: 'Popup window closed' });
    await assert.rejects(errPromise, /Popup window closed/);
  });
});

test('public/_headers keeps existing security headers and allows OAuth popups via COOP', () => {
  const headers = readFileSync('public/_headers', 'utf8');
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Referrer-Policy:\s*strict-origin-when-cross-origin/);
  assert.match(headers, /Cross-Origin-Opener-Policy:\s*same-origin-allow-popups/);
});
