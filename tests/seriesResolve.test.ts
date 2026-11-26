import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { cleanSeriesName, findSeries } from '../src/server/lineup/seriesResolve.ts';

test('a new series name drops the ticket title extras', () => {
  const cases: Array<[string, string]> = [
    ['Coachella 2023 Weekend 1', 'Coachella'],
    ['2024 Dreamstate SoCal', 'Dreamstate SoCal'],
    ['Ninajirachi - 2nd Show Added!', 'Ninajirachi'],
    ['Forester (DJ Set)', 'Forester'],
    ['Illenium Trilogy Los Angeles (Ages 18+ w/ Valid I.D.)', 'Illenium Trilogy Los Angeles'],
    ['Tove Lo - Dirt Femme Tour with Special Guest Slayyyter', 'Tove Lo - Dirt Femme Tour'],
    ['K?D w/ Special Guest 1788-L', 'K?D'],
    ['SABAI presents IKIGAI LIVE', 'SABAI: IKIGAI LIVE'],
    ['Sneijder pres ALT1', 'Sneijder: ALT1'],
    ['Zedd in the Park', 'Zedd in the Park'],
    ['Taylor Swift | The Eras Tour', 'Taylor Swift | The Eras Tour'],
  ];
  for (const [raw, want] of cases) assert.equal(cleanSeriesName(raw), want, raw);
});

test('a name that is only extras keeps the original', () => {
  assert.equal(cleanSeriesName('2024'), '2024');
});

async function storeWith(series: Array<{ slug: string; name: string; aliases?: string[]; brand?: string }>) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'series-resolve-')));
  for (const s of series) await store.upsertSeries(s);
  return store;
}

test('an event finds its series by slug, name or other name, with the title extras ignored', async () => {
  const store = await storeWith([
    { slug: 'coachella-weekend-1', name: 'Coachella', aliases: ['coachella'] },
    { slug: 'edc-las-vegas', name: 'EDC Las Vegas', aliases: ['EDC'], brand: 'EDC' },
    { slug: 'lost-in-dreams', name: 'Lost In Dreams SoCal', aliases: ['Lost in Dreams Los Angeles'] },
  ]);
  assert.equal((await findSeries(store, 'Coachella 2025 Weekend 1'))?.slug, 'coachella-weekend-1');
  assert.equal((await findSeries(store, 'Coachella 2026'))?.slug, 'coachella-weekend-1');
  assert.equal((await findSeries(store, '2027 EDC'))?.slug, 'edc-las-vegas');
  assert.equal((await findSeries(store, 'Lost in Dreams Los Angeles 2026'))?.slug, 'lost-in-dreams');
  assert.equal(await findSeries(store, 'Ultra Miami 2026'), null);
});

test('a brand alone never matches, and two matching series give none', async () => {
  const store = await storeWith([
    { slug: 'dreamstate-socal', name: 'Dreamstate SoCal', brand: 'Dreamstate', aliases: ['Dreamstate Long Beach'] },
    { slug: 'dreamstate-vancouver', name: 'Dreamstate Vancouver', brand: 'Dreamstate' },
    { slug: 'a', name: 'Restricted' },
    { slug: 'b', name: 'Night Shift', aliases: ['Restricted'] },
  ]);
  assert.equal(await findSeries(store, 'Dreamstate Europe 2026'), null);
  assert.equal(await findSeries(store, 'Restricted 2026'), null);
});
