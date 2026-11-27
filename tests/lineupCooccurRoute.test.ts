import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { genresRouter } from '../src/server/events/genreRoutes.ts';
import { ownerOnly, runAsMember } from '../src/server/auth/requestScope.ts';
import { undoGenreVocabChange } from '../src/server/events/genreVocabularyManage.ts';
import type { Edition } from '../src/server/lineup/types.ts';
import type { VocabGenre } from '../src/server/events/genreTypes.ts';

const json = { 'content-type': 'application/json' };
const now = new Date('2026-11-27T00:00:00Z');

const edition = (id: string, acts: string[]): Edition =>
  ({
    id,
    key: `${id}/2026`,
    year: 2026,
    name: id,
    status: 'verified',
    performances: acts.map((a) => ({ artistKey: a, name: a, days: [], stages: [], status: 'billed', confidence: 1, verification: 'verified', sources: [] })),
    updatedAt: '2026-11-27T00:00:00.000Z',
  }) as unknown as Edition;

const genre = (key: string, relations: VocabGenre['relations'] = []): VocabGenre => ({ key, name: key, level: 'genre', aliases: [], umbrellas: [], relations });

// Three genres, one act each. All three acts share four bills, so every pair is a full-strength link.
// house-disco is curated and techno-disco is the owner's artist_cooccur file, so only house-techno is learned.
async function fixture(store: FileLineupStore) {
  // Links go in after their targets exist, as the vocabulary requires.
  const meta = { operation: 'relations-import' as const, actor: 'owner' as const, reason: 'test', summary: 'test' };
  await store.writeGenreVocabulary([{ key: 'disco', image: genre('disco') }, { key: 'house', image: genre('house') }, { key: 'techno', image: genre('techno') }], meta);
  await store.writeGenreVocabulary(
    [
      { key: 'house', image: genre('house', [{ target: 'disco', type: 'adjacent', weight: 0.5, origin: 'curated' }]) },
      { key: 'techno', image: genre('techno', [{ target: 'disco', type: 'adjacent', weight: 0.4, origin: 'artist_cooccur' }]) },
    ],
    meta,
  );
  const checkedAt = '2026-11-01T00:00:00.000Z';
  await store.putArtistGenres([
    { key: 'a1', name: 'A1', source: 'music-story', genres: [{ parent: 'electronic', style: 'house', weight: 1 }], checkedAt },
    { key: 'a2', name: 'A2', source: 'music-story', genres: [{ parent: 'electronic', style: 'techno', weight: 1 }], checkedAt },
    { key: 'a3', name: 'A3', source: 'music-story', genres: [{ parent: 'electronic', style: 'disco', weight: 1 }], checkedAt },
  ]);
  for (const id of ['ed-1', 'ed-2', 'ed-3', 'ed-4']) await store.upsertEdition(edition(id, ['a1', 'a2', 'a3']));
}

async function withApp(fn: (app: express.Express, store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lineup-cooccur-route-'));
  try {
    const store = new FileLineupStore(dir);
    await fixture(store);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', genresRouter({ store, fetcher: {} as any, now: () => now } as any));
    await fn(app, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const asRole = <T>(role: 'owner' | 'member', store: FileLineupStore, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runAsMember({ role, userId: `u-${role}`, email: `${role}@example.test` } as any, store as any, () => fn().then(resolve, reject)),
  );

const post = (app: express.Express, url: string, body: unknown = {}) => dispatch(app, { url, method: 'POST', headers: json, body });
const PREVIEW = '/api/artist-genres/relations/lineup/preview';
const APPLY = '/api/artist-genres/relations/lineup/apply';

const lineupRows = (g: VocabGenre | undefined) => (g?.relations ?? []).filter((r) => r.origin === 'lineup_cooccur');

test('lineup routes are owner-only in requestScope', () => {
  assert.equal(ownerOnly('POST', PREVIEW), true);
  assert.equal(ownerOnly('POST', APPLY), true);
});

test('preview lists the learned link and writes nothing', async () => {
  await withApp(async (app, store) => {
    const changesBefore = (await store.listGenreVocabChanges({})).length;
    const res = await asRole('owner', store, () => post(app, PREVIEW));
    assert.equal(res.status, 200);
    const { preview } = res.json<{ preview: any }>();
    assert.equal(preview.billsUsed, 4);
    assert.equal(preview.genres, 3);
    assert.equal(preview.added, 1);
    assert.equal(preview.removed, 0);
    assert.equal(preview.changed, 0);
    assert.equal(preview.unchanged, 0);
    assert.equal(preview.addedLinks.length, 1);
    const link = preview.addedLinks[0];
    assert.equal(link.source, 'house');
    assert.equal(link.target, 'techno');
    assert.equal(link.weight, 1);
    assert.equal(link.bills, 4);
    assert.equal(link.sourceName, 'house');
    assert.equal(link.targetName, 'techno');
    assert.equal((await store.listGenreVocabChanges({})).length, changesBefore);
    assert.deepEqual(lineupRows((await store.getGenreVocabulary()).genres.find((g) => g.key === 'house')), []);
  });
});

test('apply writes origin lineup_cooccur rows, logged by the system, and leaves curated and artist_cooccur pairs alone', async () => {
  await withApp(async (app, store) => {
    const res = await asRole('owner', store, () => post(app, APPLY));
    assert.equal(res.status, 200);
    const body = res.json<{ preview: any; change: any }>();
    assert.equal(body.preview.added, 1);
    assert.equal(body.change.actor, 'system:lineup-cooccur');
    assert.equal(body.change.reason, 'Learned from shared lineups');
    assert.equal(body.change.operation, 'relations-import');

    const vocab = await store.getGenreVocabulary();
    const house = vocab.genres.find((g) => g.key === 'house');
    assert.deepEqual(lineupRows(house), [{ target: 'techno', type: 'adjacent', weight: 1, origin: 'lineup_cooccur' }]);
    assert.ok(house?.relations?.some((r) => r.target === 'disco' && r.origin === 'curated' && r.weight === 0.5));
    const techno = vocab.genres.find((g) => g.key === 'techno');
    assert.ok(techno?.relations?.some((r) => r.target === 'disco' && r.origin === 'artist_cooccur' && r.weight === 0.4));
    assert.deepEqual(lineupRows(techno), []);
    // No house-disco link was learned: that pair is curated.
    assert.equal(vocab.genres.flatMap((g) => g.relations ?? []).filter((r) => r.origin === 'lineup_cooccur').length, 1);
  });
});

test('a second apply replaces the old lineup_cooccur rows and leaves the others', async () => {
  await withApp(async (app, store) => {
    await asRole('owner', store, () => post(app, APPLY));
    // A stale learned link that the shared lineups no longer support.
    await store.writeGenreVocabulary(
      [{ key: 'techno', image: genre('techno', [
        { target: 'disco', type: 'adjacent', weight: 0.4, origin: 'artist_cooccur' },
        { target: 'disco', type: 'adjacent', weight: 0.9, origin: 'lineup_cooccur' },
      ]) }],
      { operation: 'relations-import', actor: 'system:lineup-cooccur', reason: 'test', summary: 'test' },
    );
    const res = await asRole('owner', store, () => post(app, APPLY));
    const body = res.json<{ preview: any; change: any }>();
    assert.equal(body.preview.removed, 1);
    assert.equal(body.preview.unchanged, 1);
    const vocab = await store.getGenreVocabulary();
    const techno = vocab.genres.find((g) => g.key === 'techno');
    assert.deepEqual(lineupRows(techno), []);
    assert.ok(techno?.relations?.some((r) => r.origin === 'artist_cooccur'));
    assert.equal(lineupRows(vocab.genres.find((g) => g.key === 'house')).length, 1);
  });
});

test('undo restores the links the apply replaced', async () => {
  await withApp(async (app, store) => {
    const res = await asRole('owner', store, () => post(app, APPLY));
    const id = res.json<{ change: { id: string } }>().change.id;
    assert.equal(lineupRows((await store.getGenreVocabulary()).genres.find((g) => g.key === 'house')).length, 1);
    await undoGenreVocabChange(store, id, now);
    assert.deepEqual(lineupRows((await store.getGenreVocabulary()).genres.find((g) => g.key === 'house')), []);
  });
});

test('a member gets 403 on preview and apply, and nothing is written', async () => {
  await withApp(async (app, store) => {
    const before = await store.getGenreVocabulary();
    const changesBefore = (await store.listGenreVocabChanges({})).length;
    for (const url of [PREVIEW, APPLY]) {
      const res = await asRole('member', store, () => post(app, url));
      assert.equal(res.status, 403, url);
    }
    assert.deepEqual(await store.getGenreVocabulary(), before);
    assert.equal((await store.listGenreVocabChanges({})).length, changesBefore);
  });
});
