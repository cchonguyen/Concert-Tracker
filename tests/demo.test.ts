import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { guardServerCalls, DEMO_GUARD_MESSAGE } from '../src/demo/guard.ts';
import { sampleEvents, sampleLineups, samplePoints } from '../src/demo/sampleData.ts';

const root = path.resolve(import.meta.dirname, '..');

// Every .ts/.tsx file under the given directories (not node_modules, not dist).
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
  };
  dirs.forEach((d) => walk(path.join(root, d)));
  return out;
}

test('the demo guard refuses every /api request and lets the rest through', async () => {
  const calls: string[] = [];
  const guarded = guardServerCalls(async (input) => {
    calls.push(String(input));
    return new Response('ok');
  });
  for (const url of ['/api/events', 'https://example.com/api/events', '/api']) {
    await assert.rejects(guarded(url), new RegExp(DEMO_GUARD_MESSAGE.replace('.', '\\.')));
  }
  assert.equal((await guarded('/assets/app.js')).status, 200);
  assert.deepEqual(calls, ['/assets/app.js']);
});

test('nothing outside src/demo imports from src/demo (sample data stays in the demo)', () => {
  const offenders = sourceFiles(['src', 'worker', 'tests', 'scripts'])
    .filter((file) => !file.includes(`${path.sep}src${path.sep}demo${path.sep}`) && !file.endsWith('demo.test.ts'))
    .filter((file) => /from\s+['"][^'"]*\bdemo\/[^'"]*['"]|import\(\s*['"][^'"]*\bdemo\//.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), []);
});

test('the sample has what the demo promises to show', () => {
  assert.ok(sampleEvents.length >= 25, `only ${sampleEvents.length} events`);
  assert.equal(new Set(sampleEvents.map((e) => e.id)).size, sampleEvents.length, 'event ids repeat');
  const series = sampleEvents.filter((e) => e.series === 'Harbor Sound Festival');
  assert.equal(new Set(series.map((e) => e.year ?? e.startDate?.slice(0, 4))).size, 3, 'a series across three years');
  assert.ok(sampleEvents.some((e) => e.seen.some((a) => (a.b2b ?? []).length > 0)), 'a B2B set');
  assert.ok(sampleEvents.some((e) => e.weather), 'historical weather');
  assert.ok(sampleEvents.some((e) => e.companions.length > 0), 'companions');
  assert.ok(sampleEvents.some((e) => e.sources.startDate?.quote), 'a verbatim source quote');
  assert.ok(sampleEvents.some((e) => !e.venue), 'an honest gap: a missing venue');
});

test('every sample event has a lineup summary, and every city has a point for the map', () => {
  for (const e of sampleEvents) assert.ok(sampleLineups[e.id], e.id);
  for (const e of sampleEvents) {
    if (e.city) assert.ok(samplePoints[e.city], `no point for ${e.city}`);
  }
});

test('the sample names no real artist by design: the demo shows the sample marker in its own files only', () => {
  const marker = 'Harbor Sound Festival';
  const appFiles = sourceFiles(['src']).filter((f) => !f.includes(`${path.sep}src${path.sep}demo${path.sep}`));
  for (const file of appFiles) assert.ok(!readFileSync(file, 'utf8').includes(marker), path.relative(root, file));
});
