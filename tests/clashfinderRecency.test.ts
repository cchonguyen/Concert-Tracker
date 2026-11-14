import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clashfinderCandidates, matchEdition, parseEventList, rankEditions, recencyMs } from '../src/server/lineup/adapters/clashfinder.ts';

test('clashfinderCandidates lists every match best first, with the automatic pick on top', async () => {
  const prev = { user: process.env.CLASHFINDER_USERNAME, key: process.env.CLASHFINDER_PUBLIC_KEY };
  process.env.CLASHFINDER_USERNAME = 'tester';
  process.env.CLASHFINDER_PUBLIC_KEY = 'abc';
  try {
    const body = JSON.stringify({
      foo2026old: { desc: 'Foo Festival 2026', startDate: 1780000000, edits: 900, lastEdit: '2026-03-01 10:00' },
      foo2026new: { desc: 'Foo Festival 2026', startDate: 1780000000, edits: 40, lastEdit: '2026-10-17 10:37' },
      foo2026priv: { desc: 'Foo Festival 2026', startDate: 1780000000, private: true },
    });
    const calls: string[] = [];
    const fetcher = {
      get: async (url: string) => {
        calls.push(url);
        return { status: 200, url, body, headers: {} };
      },
    } as any;
    const out = await clashfinderCandidates(fetcher, { eventName: 'Foo Festival', year: 2026 });
    assert.equal(calls.length, 1, 'one list call');
    assert.deepEqual(out.map((c) => c.slug), ['foo2026new', 'foo2026old']);
    assert.equal(out[0].url, 'https://clashfinder.com/s/foo2026new/');
  } finally {
    if (prev.user === undefined) delete process.env.CLASHFINDER_USERNAME; else process.env.CLASHFINDER_USERNAME = prev.user;
    if (prev.key === undefined) delete process.env.CLASHFINDER_PUBLIC_KEY; else process.env.CLASHFINDER_PUBLIC_KEY = prev.key;
  }
});

test('parseEventList reads lastEdit or modified as written', () => {
  const list = parseEventList({
    a2026: { desc: 'Foo Festival 2026', startDate: 1780000000, lastEdit: '2026-10-17 10:37' },
    b2026: { desc: 'Foo Festival 2026', startDate: 1780000000, modified: '2026-09-01 08:00' },
    c2026: { desc: 'Foo Festival 2026', startDate: 1780000000 },
  });
  const byslug = Object.fromEntries(list.map((e) => [e.slug, e.lastEdit]));
  assert.equal(byslug.a2026, '2026-10-17 10:37');
  assert.equal(byslug.b2026, '2026-09-01 08:00');
  assert.equal(byslug.c2026, undefined);
});

test('automatic pick takes the most recently edited of equally fitting clashes, not the most edited', () => {
  const list = parseEventList({
    foo2026old: { desc: 'Foo Festival 2026', startDate: 1780000000, edits: 900, lastEdit: '2026-03-01 10:00' },
    foo2026new: { desc: 'Foo Festival 2026', startDate: 1780000000, edits: 40, lastEdit: '2026-10-17 10:37' },
  });
  assert.equal(matchEdition(list, 'Foo Festival', 2026)?.slug, 'foo2026new');
});

test('a clash without a date sorts below one with a date, then falls back to edit count', () => {
  const list = parseEventList({
    undated: { desc: 'Foo Festival 2026', startDate: 1780000000, edits: 500 },
    dated: { desc: 'Foo Festival 2026', startDate: 1780000000, edits: 2, lastEdit: '2026-01-01 00:00' },
    undatedFewer: { desc: 'Foo Festival 2026', startDate: 1780000000, edits: 10 },
  });
  const order = rankEditions(list, 'Foo Festival', 2026).map((e) => e.slug);
  assert.deepEqual(order, ['dated', 'undated', 'undatedFewer']);
});

test('edition fit still beats recency: a date-matched weekend wins over a newer edit', () => {
  const list = parseEventList({
    coachella2024w1: { desc: 'Coachella 2024 Weekend 1', startDate: '2024-04-12', edits: 900, lastEdit: '2026-10-17 10:37' },
    coachella2024w2: { desc: 'Coachella 2024 Weekend 2', startDate: '2024-04-19', edits: 300, lastEdit: '2024-04-01 00:00' },
  });
  assert.equal(matchEdition(list, 'Coachella Weekend 2', 2024, '2024-04-19')?.slug, 'coachella2024w2');
});

test('rankEditions returns every public, non-speculative match and no private or fantasy ones', () => {
  const list = parseEventList({
    foo2026: { desc: 'Foo Festival 2026', startDate: 1780000000, lastEdit: '2026-10-01 00:00' },
    foo2026b: { desc: 'Foo Festival 2026 Stage Set', startDate: 1780000000, lastEdit: '2026-09-01 00:00' },
    foo2026priv: { desc: 'Foo Festival 2026', startDate: 1780000000, private: true, lastEdit: '2026-11-01 00:00' },
    foo2026fantasy: { desc: 'Foo Festival 2026 fantasy lineup', startDate: 1780000000, lastEdit: '2026-11-02 00:00' },
  });
  const slugs = rankEditions(list, 'Foo Festival', 2026).map((e) => e.slug);
  assert.deepEqual(slugs, ['foo2026', 'foo2026b']);
});

test('recencyMs orders dates and treats a missing date as lowest', () => {
  assert.ok(recencyMs('2026-10-17 10:37') > recencyMs('2026-10-17 10:36'));
  assert.ok(recencyMs('2026-10-17 10:37') > recencyMs('2025-12-31 23:59'));
  assert.equal(recencyMs(undefined), Number.NEGATIVE_INFINITY);
  assert.equal(recencyMs('not a date'), Number.NEGATIVE_INFINITY);
});
