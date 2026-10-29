// Installed before anything else in the demo (see main.tsx). The demo never
// talks to the server: any request to /api throws here, so a view that starts
// calling the API fails loudly in the demo instead of reaching the database.
// tests/demo.test.ts drives every demo screen and expects none to get through.

export const DEMO_GUARD_MESSAGE = 'The demo makes no server calls.';

export function guardServerCalls(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api' || path.startsWith('/api/')) return Promise.reject(new Error(`${DEMO_GUARD_MESSAGE} (${path})`));
    return inner(input, init);
  };
}

if (typeof window !== 'undefined') window.fetch = guardServerCalls(window.fetch.bind(window));
