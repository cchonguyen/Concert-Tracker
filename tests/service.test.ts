import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/server/lineup/service.ts';

test('createStore refuses the file store when Supabase is required', async () => {
  const saved = { url: process.env.SUPABASE_URL, store: process.env.LINEUP_STORE };
  delete process.env.SUPABASE_URL;
  process.env.LINEUP_STORE = 'file';
  try {
    await assert.rejects(createStore({ requireSupabase: true }), /SUPABASE_URL/);
    assert.equal((await createStore()).kind, 'file');
  } finally {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.store === undefined) delete process.env.LINEUP_STORE;
    else process.env.LINEUP_STORE = saved.store;
  }
});
