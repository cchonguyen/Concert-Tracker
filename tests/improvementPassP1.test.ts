import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isSignedIn } from '../src/server/share/door.ts';
import { runMemberBackfill, type MemberBackfillMember } from '../src/server/canon/memberBackfill.ts';
import { NOTICE_SETTING, NOTICE_VERSION } from '../src/server/auth/routes.ts';
import { MEMBER_BACKFILL_SETTING } from '../src/server/canon/memberBackfill.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import { createStore } from '../src/server/lineup/service.ts';
import { newEvent } from '../src/server/events/service.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const NOW = new Date('2026-11-18T12:00:00Z');

async function withTempStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-pass-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('P3.1: isSignedIn returns false without calling verify when CF_Authorization cookie is absent', async () => {
  let calls = 0;
  const verify = async (token: string | null | undefined) => {
    calls++;
    return token === 'good-jwt';
  };
  const access = { teamDomain: 'https://team.cloudflareaccess.com', aud: 'aud' };
  const anonReq = new Request('https://concert.example/', { headers: { cookie: 'other=1' } });
  assert.equal(await isSignedIn(anonReq, access, verify), false);
  assert.equal(calls, 0, 'verify must not be called for anonymous visits');

  const authedReq = new Request('https://concert.example/', { headers: { cookie: 'CF_Authorization=good-jwt' } });
  assert.equal(await isSignedIn(authedReq, access, verify), true);
  assert.equal(calls, 1);
});

test('P1.2: runMemberBackfill prefetches settings in 1 query across 15 members and skips per-member getSetting', async () => {
  await withTempStore(async (store) => {
    const members: MemberBackfillMember[] = [];
    for (let i = 0; i < 15; i++) {
      const userId = `u-${i}`;
      members.push({ userId, role: 'member' });
      const scoped = store.forUser({ userId, role: 'member' });
      await scoped.putSetting(NOTICE_SETTING, { version: NOTICE_VERSION, acceptedAt: NOW.toISOString() });
      await scoped.putSetting(MEMBER_BACKFILL_SETTING, { done: [], complete: true });
    }

    let listBatchCalls = 0;
    let scopedGetCalls = 0;
    const spyStore = Object.assign(Object.create(store), {
      listUserSettingsByKeys: async (keys: string[]) => {
        listBatchCalls++;
        const want = new Set(keys);
        const { userSettings } = await store.ownersState();
        const out: Array<{ userId: string; key: string; data: unknown }> = [];
        for (const [userId, entries] of Object.entries(userSettings)) {
          for (const [key, data] of Object.entries(entries)) {
            if (want.has(key)) out.push({ userId, key, data });
          }
        }
        return out;
      },
      forUser: (scope: any) => {
        const inner = store.forUser(scope);
        return Object.assign(Object.create(inner), {
          getSetting: async (k: string) => {
            scopedGetCalls++;
            return inner.getSetting(k);
          },
        });
      },
    }) as FileLineupStore;

    const report = await runMemberBackfill(spyStore, members, { budgetLeft: () => 1000 });
    assert.equal(report, null, 'all completed members yield idle null');
    assert.equal(listBatchCalls, 1, 'should prefetch notice and cursor settings in 1 batch call');
    assert.equal(scopedGetCalls, 0, 'must not call per-member getSetting when listUserSettingsByKeys exists');
  });
});

test('P2.1: upsertEdition sets has_lineup=true when performances are present and preserves false/null when empty', async () => {
  await withTempStore(async (store) => {
    const withPerfs: Edition = {
      id: 'ed-with-perfs',
      key: 'fest/2026',
      year: 2026,
      name: 'Fest 2026',
      status: 'verified',
      performances: [
        { artistKey: 'tsha', name: 'Tsha', days: [], stages: [], status: 'billed', confidence: 1, sources: [] },
      ],
      updatedAt: NOW.toISOString(),
    };
    await store.upsertEdition(withPerfs);
    assert.equal((await store.getEdition('ed-with-perfs'))?.hasLineup, true);

    const emptyFalse: Edition = {
      id: 'ed-empty-false',
      key: 'fest2/2026',
      year: 2026,
      name: 'Fest2 2026',
      status: 'verified',
      hasLineup: false,
      performances: [],
      updatedAt: NOW.toISOString(),
    };
    await store.upsertEdition(emptyFalse);
    assert.equal((await store.getEdition('ed-empty-false'))?.hasLineup, false);
  });

  // Also verify SupabaseLineupStore.upsertEdition sends has_lineup: true when performances > 0.
  const written: Array<Record<string, unknown>> = [];
  const fakeDb = {
    from(table: string) {
      return {
        upsert(row: any) {
          if (table === 'event_editions') written.push(row);
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq: () => Promise.resolve({ error: null }),
          };
        },
        insert() {
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            in: () => Promise.resolve({ data: [], error: null }),
          };
        },
      };
    },
  } as any;
  const supa = new SupabaseLineupStore(fakeDb);
  await supa.upsertEdition({
    id: 'ed-supa',
    key: 'supa/2026',
    year: 2026,
    name: 'Supa 2026',
    status: 'verified',
    performances: [{ artistKey: 'zedd', name: 'Zedd', days: [], stages: [], status: 'billed', confidence: 1, sources: [] }],
    updatedAt: NOW.toISOString(),
  });
  assert.equal(written.length, 1);
  assert.equal(written[0].has_lineup, true);
});

test('P1.1 & P1.2: createStore({ requireSupabase: true }) skips startup probes and listPendingResearchUserIds finds pending owners', async () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: globalThis.fetch,
  };
  let fetchCalls = 0;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error('unexpected probe fetch');
  }) as typeof fetch;

  try {
    const store = await createStore({ requireSupabase: true });
    assert.equal(store.kind, 'supabase');
    assert.equal(fetchCalls, 0, 'requireSupabase=true must make 0 startup table probe requests');
  } finally {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    globalThis.fetch = saved.fetch;
  }

  await withTempStore(async (store) => {
    assert.deepEqual(await store.listPendingResearchUserIds(), []);
    const u1 = store.forUser({ userId: 'u-1', role: 'member' });
    await u1.putEvent(newEvent('Artist 2025', NOW));
    assert.deepEqual(await store.listPendingResearchUserIds(), ['u-1']);
  });
});
