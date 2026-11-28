import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { baseName, findSeriesIssues, fixSeriesIssue, qualifierFrom } from '../src/server/entities/seriesHealth.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Edition, EditionHeader, SeriesRecord } from '../src/server/lineup/types.ts';

const ed = (id: string, name: string, seriesSlug?: string): EditionHeader => ({ id, key: id, year: 2024, name, status: 'verified', seriesSlug, updatedAt: '2026-11-01T00:00:00.000Z' } as EditionHeader);
const none = { acts: [], events: [] };

test('helpers: year removed, brand prefix removed', () => {
  assert.equal(baseName('Coachella 2024'), 'Coachella');
  assert.equal(baseName('2019 Lightning in a Bottle'), 'Lightning in a Bottle');
  assert.equal(qualifierFrom('Kylie Minogue: Tension Tour', 'Kylie Minogue'), 'Tension Tour');
  assert.equal(qualifierFrom('EDC Las Vegas', 'EDC'), 'Las Vegas');
  assert.equal(qualifierFrom('Tension Tour', 'Kylie Minogue'), 'Tension Tour');
});

test('a series with no brand: one act across its editions is offered as the brand, else its own name', () => {
  const series: SeriesRecord[] = [{ slug: 'alive', name: 'Alive' }, { slug: 'ultra', name: 'Ultra' }];
  const editions = [ed('e1', 'Alive 2007', 'alive'), ed('e2', 'Ultra 2024', 'ultra')];
  const acts = [
    { editionId: 'e1', artistKey: 'daft punk', name: 'Daft Punk', status: 'billed' as const },
    { editionId: 'e2', artistKey: 'a', name: 'A', status: 'billed' as const },
    { editionId: 'e2', artistKey: 'b', name: 'B', status: 'billed' as const },
  ];
  const issues = findSeriesIssues({ series, editions, acts, events: [] });
  assert.deepEqual(issues.find((i) => i.id === 'no-brand:alive')?.steps, [{ op: 'series', slug: 'alive', brand: 'Daft Punk', qualifier: 'Alive', aliases: ['Alive'] }]);
  assert.deepEqual(issues.find((i) => i.id === 'no-brand:ultra')?.steps, [{ op: 'series', slug: 'ultra', brand: 'Ultra' }]);
});

test('the owner’s own ticks on linked events count as acts', () => {
  const series: SeriesRecord[] = [{ slug: 'vertigo', name: 'Vertigo' }];
  const events = [{ id: 'x', name: 'Vertigo', editionId: 'e1', seen: [{ key: 'griff', name: 'Griff', from: 'you' }] }] as any;
  const [issue] = findSeriesIssues({ series, editions: [ed('e1', 'Vertigo', 'vertigo')], acts: [], events });
  assert.equal(issue.steps[0].op === 'series' && issue.steps[0].brand, 'Griff');
});

test('a branded series not built from its brand is offered the rest of its name as qualifier; built ones are fine', () => {
  const series: SeriesRecord[] = [
    { slug: 'edc', name: 'EDC Las Vegas', brand: 'EDC' },
    { slug: 'ok', name: 'EDC Orlando', brand: 'EDC', qualifier: 'Orlando' },
    { slug: 'plain', name: 'Coachella', brand: 'Coachella' },
  ];
  const issues = findSeriesIssues({ series, editions: [], ...none });
  assert.deepEqual(issues.map((i) => i.id), ['not-built:edc']);
  assert.deepEqual(issues[0].steps, [{ op: 'series', slug: 'edc', qualifier: 'Las Vegas', aliases: ['EDC Las Vegas'] }]);
});

test('editions with no series: a matching series is offered; a recurring name gets a new series; a one-off night is left alone', () => {
  const series: SeriesRecord[] = [{ slug: 'coachella', name: 'Coachella', brand: 'Coachella' }];
  const editions = [ed('c1', 'Coachella 2023'), ed('h1', 'HARD Summer 2022'), ed('h2', 'HARD Summer 2023'), ed('o1', 'Some Artist at The Venue')];
  const issues = findSeriesIssues({ series, editions, ...none });
  assert.deepEqual(issues.find((i) => i.id === 'no-series:coachella')?.steps, [{ op: 'edition', id: 'c1', seriesSlug: 'coachella' }]);
  const hard = issues.find((i) => i.id.startsWith('no-series:hard'));
  assert.deepEqual(hard?.steps, [
    { op: 'series', slug: 'hard-summer', create: true, name: 'HARD Summer', brand: 'HARD Summer' },
    { op: 'edition', id: 'h1', seriesSlug: 'hard-summer' },
    { op: 'edition', id: 'h2', seriesSlug: 'hard-summer' },
  ]);
  assert.equal(issues.filter((i) => i.kind === 'no-series').length, 2);
});

test('a fix runs from live data as the owner and the issue is gone after', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'sh-')));
  await store.upsertSeries({ slug: 'coachella', name: 'Coachella', brand: 'Coachella' });
  await store.upsertEdition({ id: 'c1', key: 'coachella/2023', year: 2023, name: 'Coachella 2023', status: 'verified', performances: [], updatedAt: '2026-11-01T00:00:00.000Z' } as Edition);
  const results = await fixSeriesIssue(store, 'no-series:coachella', 'owner');
  assert.deepEqual(results?.map((r) => r.outcome), ['done']);
  assert.equal((await store.getEdition('c1'))?.seriesSlug, 'coachella');
  assert.equal(await fixSeriesIssue(store, 'no-series:coachella', 'owner'), null);
});
