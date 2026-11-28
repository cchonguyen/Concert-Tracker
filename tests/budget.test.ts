import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExhausted, countingFetch, currentBudget, makeBudget, runWithBudget } from '../src/server/lineup/budget.ts';
import { createRateLimitedFetcher } from '../src/server/lineup/http.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Replaces the global fetch for one test. The test's t.after restores it.
function stubFetch(t: { after: (fn: () => void) => void }, handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

test('budget: ordinary takes stop at limit minus reserve, reserved takes reach the limit', () => {
  const budget = makeBudget();
  assert.equal(budget.reserve, 4);
  const ordinary = budget.limit - budget.reserve;
  for (let i = 0; i < ordinary; i++) budget.take();
  assert.equal(budget.used, ordinary);
  assert.throws(() => budget.take(), BudgetExhausted);
  assert.equal(budget.used, ordinary);

  for (let i = 0; i < budget.reserve; i++) budget.take(1, { reserved: true });
  assert.equal(budget.used, budget.limit);
  assert.throws(() => budget.take(1, { reserved: true }), BudgetExhausted);
  assert.throws(() => budget.take(), BudgetExhausted);
});

test('budget: BudgetExhausted carries used and limit', () => {
  const budget = makeBudget();
  budget.take(budget.limit - budget.reserve);
  assert.throws(
    () => budget.take(),
    (err: unknown) => err instanceof BudgetExhausted && err.used === budget.limit - budget.reserve && err.limit === budget.limit,
  );
});

test('budget: concurrent runWithBudget calls count separately', async () => {
  const a = makeBudget();
  const b = makeBudget();
  await Promise.all([
    runWithBudget(a, async () => {
      for (let i = 0; i < 3; i++) {
        await tick();
        currentBudget()!.take();
      }
    }),
    runWithBudget(b, async () => {
      for (let i = 0; i < 5; i++) {
        await tick();
        currentBudget()!.take();
      }
    }),
  ]);
  assert.equal(a.used, 3);
  assert.equal(b.used, 5);
});

test('fetcher: charges one per attempt and one per redirect hop, returns the final URL', async (t) => {
  const calls = stubFetch(t, (url) => {
    if (url === 'https://example.org/a') return redirect('https://example.org/b');
    if (url === 'https://example.org/b') return redirect('/c');
    return new Response('done', { status: 200 });
  });
  const budget = makeBudget();
  const res = await runWithBudget(budget, () => createRateLimitedFetcher().get('https://example.org/a'));
  assert.equal(res.status, 200);
  assert.equal(res.body, 'done');
  assert.equal(res.url, 'https://example.org/c');
  assert.deepEqual(calls, ['https://example.org/a', 'https://example.org/b', 'https://example.org/c']);
  assert.equal(budget.used, 3);
});

test('fetcher: refuses a redirect to 127.0.0.1', async (t) => {
  const calls = stubFetch(t, () => redirect('http://127.0.0.1/secret'));
  await assert.rejects(
    () => createRateLimitedFetcher().get('https://example.org/start'),
    /Refusing private or local address/,
  );
  assert.equal(calls.length, 1);
});

test('fetcher: stops after three redirect hops', async (t) => {
  let n = 0;
  const calls = stubFetch(t, () => redirect(`https://example.org/hop${++n}`));
  const budget = makeBudget();
  await assert.rejects(
    () => runWithBudget(budget, () => createRateLimitedFetcher().get('https://example.org/')),
    /Too many redirects for example\.org/,
  );
  assert.equal(calls.length, 4);
  assert.equal(budget.used, 4);
});

test('fetcher: a body over maxBytes is cut and marked truncated', async (t) => {
  const enc = new TextEncoder();
  stubFetch(t, () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('a'.repeat(60)));
        controller.enqueue(enc.encode('b'.repeat(60)));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  });
  const res = await createRateLimitedFetcher().get('https://example.org/big', { maxBytes: 100 });
  assert.equal(res.body, 'a'.repeat(60) + 'b'.repeat(40));
  assert.equal(res.body.length, 100);
  assert.equal(res.truncated, true);
});

test('fetcher: a content-length over maxBytes is refused without reading the body', async (t) => {
  let cancelled = false;
  stubFetch(t, () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-length': '1000' } });
  });
  await assert.rejects(() => createRateLimitedFetcher().get('https://example.org/huge', { maxBytes: 100 }), /larger than 100 bytes/);
  assert.equal(cancelled, true);
});

test('countingFetch: Supabase calls are counted inside a budget', async (t) => {
  const calls = stubFetch(t, () => new Response('[]', { status: 200 }));
  const budget = makeBudget();
  await runWithBudget(budget, async () => {
    await countingFetch('https://example.supabase.co/rest/v1/lookup_jobs');
    await countingFetch('https://example.supabase.co/rest/v1/logged_events');
  });
  assert.equal(calls.length, 2);
  assert.equal(budget.used, 2);
});

test('budget: outside a budget nothing is counted and nothing throws', async (t) => {
  const calls = stubFetch(t, () => new Response('ok', { status: 200 }));
  assert.equal(currentBudget(), undefined);
  const res = await countingFetch('https://example.supabase.co/rest/v1/x');
  assert.equal(res.status, 200);
  const fetched = await createRateLimitedFetcher().get('https://example.org/outside');
  assert.equal(fetched.body, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(currentBudget(), undefined);
});

test('a hold keeps its calls free from ordinary and reserved calls alike', () => {
  const b = makeBudget();
  b.used = b.limit - b.reserve - 2;
  b.hold = 6;
  assert.throws(() => b.take(1), BudgetExhausted);
  b.used = b.limit - 6;
  assert.throws(() => b.take(1, { reserved: true }), BudgetExhausted);
  b.hold = 0;
  b.take(4, { reserved: true });
  assert.equal(b.used, b.limit - 2);
});
