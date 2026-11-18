import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import type { EventWeather } from '../src/server/events/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const weather: EventWeather = {
  place: 'Las Vegas, NV',
  latitude: 36.17,
  longitude: -115.14,
  days: [{ date: '2026-10-10', high: 27, low: 15, precipitation: 0, code: 1 }],
  sourceUrl: 'https://archive-api.open-meteo.com/v1/archive?latitude=36.17',
  checkedAt: '2026-11-18T00:00:00.000Z',
};

const edition = (weatherField?: EventWeather | null): Edition => ({
  id: 'ed-1',
  key: 'fest-2026',
  year: 2026,
  name: 'Fest 2026',
  status: 'verified',
  updatedAt: '2026-11-18T00:00:00.000Z',
  performances: [],
  ...(weatherField !== undefined ? { weather: weatherField } : {}),
});

test('edition weather: an upsert without weather keeps the stored record', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertEdition(edition(weather));
    await store.upsertEdition(edition());
    assert.deepEqual((await store.getEdition('ed-1'))?.weather, weather);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edition weather: a value replaces the record and null clears it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertEdition(edition());
    assert.equal((await store.getEdition('ed-1'))?.weather, undefined);
    await store.upsertEdition(edition(weather));
    assert.deepEqual((await store.getEdition('ed-1'))?.weather, weather);
    await store.upsertEdition(edition(null));
    assert.equal((await store.getEdition('ed-1'))?.weather, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
