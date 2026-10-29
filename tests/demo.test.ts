import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
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

test('only sample mode and the tests import the sample data (sample data stays out of the start-up code)', () => {
  const offenders = sourceFiles(['src', 'worker', 'tests', 'scripts'])
    .filter((file) => !file.includes(`${path.sep}src${path.sep}demo${path.sep}`) && !/demo\.test\.ts|sampleMode\.test\.ts|src[\\/]services[\\/]sampleMode\.ts$/.test(file))
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

test('the sample marker appears only in the sample files', () => {
  const marker = 'Harbor Sound Festival';
  const appFiles = sourceFiles(['src']).filter((f) => !f.includes(`${path.sep}src${path.sep}demo${path.sep}`));
  for (const file of appFiles) assert.ok(!readFileSync(file, 'utf8').includes(marker), path.relative(root, file));
});
