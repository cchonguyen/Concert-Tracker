import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import type { VocabGenre } from '../src/server/events/genreTypes.ts';
import type { GenreVocabWriteMeta } from '../src/server/lineup/store/types.ts';

const OWNER = { userId: 'u-owner', role: 'owner' as const };
const ANN = { userId: 'u-ann', role: 'member' as const };

const meta = (operation: GenreVocabWriteMeta['operation'] = 'create', summary = 'changed'): GenreVocabWriteMeta => ({
  operation,
  actor: 'owner',
  reason: 'Set in the app',
  summary,
});

const genre = (key: string, patch: Partial<VocabGenre> = {}): VocabGenre => ({ key, name: key, aliases: [], umbrellas: [], ...patch });

async function fileStore() {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genre-vocab-')));
}

test('file store: an empty vocabulary reads as no genres in every scope', async () => {
  const s = await fileStore();
  assert.deepEqual(await s.getGenreVocabulary(), { genres: [] });
  assert.deepEqual(await s.forUser(ANN).getGenreVocabulary(), { genres: [] });
});

test('file store: a write stores genres, aliases and umbrellas, and logs one change with before and after', async () => {
  const s = await fileStore();
  const first = await s.writeGenreVocabulary([{ key: 'house', image: genre('house', { name: 'House', parent: 'electronic' }) }], meta('create', 'house created'));
  assert.deepEqual(first.before, []);
  assert.deepEqual(first.after, [{ key: 'house', name: 'House', parent: 'electronic', aliases: [], umbrellas: [] }]);
  assert.equal(first.operation, 'create');
  assert.equal(first.summary, 'house created');

  const second = await s.writeGenreVocabulary(
    [{ key: 'tech house', image: genre('tech house', { name: 'Tech House', aliases: [{ key: 'techhouse', alias: 'TechHouse' }], umbrellas: ['house'] }) }],
    meta('umbrella-add'),
  );
  assert.deepEqual(second.before, []);
  assert.deepEqual(second.after[0].umbrellas, ['house']);

  const vocab = await s.getGenreVocabulary();
  assert.deepEqual(
    vocab.genres.map((g) => g.key),
    ['house', 'tech house'],
  );
  assert.deepEqual(vocab.genres[1].aliases, [{ key: 'techhouse', alias: 'TechHouse' }]);
  // A member reads the same shared vocabulary.
  assert.deepEqual(await s.forUser(ANN).getGenreVocabulary(), vocab);

  const third = await s.writeGenreVocabulary([{ key: 'house', image: genre('house', { name: 'house music' }) }], meta('rename'));
  assert.equal(third.before[0].name, 'House');
  assert.equal(third.before[0].parent, 'electronic');
  assert.equal(third.after[0].name, 'house music');
  assert.equal('parent' in third.after[0], false);
});

test('file store: changes list newest first, by id and limit, and undo is set once', async () => {
  const s = await fileStore();
  const a = await s.writeGenreVocabulary([{ key: 'house', image: genre('house') }], meta('create', 'a'));
  const b = await s.writeGenreVocabulary([{ key: 'techno', image: genre('techno') }], meta('create', 'b'));
  assert.deepEqual((await s.listGenreVocabChanges({})).map((c) => c.id), [b.id, a.id]);
  assert.deepEqual((await s.listGenreVocabChanges({ limit: 1 })).map((c) => c.id), [b.id]);
  assert.deepEqual((await s.listGenreVocabChanges({ id: a.id })).map((c) => c.summary), ['a']);
  await s.markGenreVocabChangesUndone([a.id], '2026-03-01T00:00:00Z');
  await s.markGenreVocabChangesUndone([a.id], '2026-04-01T00:00:00Z');
  assert.equal((await s.listGenreVocabChanges({ id: a.id }))[0].undoneAt, '2026-03-01T00:00:00Z');
  assert.equal((await s.listGenreVocabChanges({ id: b.id }))[0].undoneAt, undefined);
});

test('file store: deleting a genre removes its links and logs the genre that lost one', async () => {
  const s = await fileStore();
  await s.writeGenreVocabulary([{ key: 'house', image: genre('house') }], meta());
  await s.writeGenreVocabulary([{ key: 'tech house', image: genre('tech house', { umbrellas: ['house'] }) }], meta());
  const change = await s.writeGenreVocabulary([{ key: 'house', image: null }], meta('merge'));
  assert.deepEqual(change.before.map((g) => g.key), ['house', 'tech house']);
  assert.deepEqual(change.after, [{ key: 'tech house', name: 'tech house', aliases: [], umbrellas: [] }]);
  assert.deepEqual((await s.getGenreVocabulary()).genres, [{ key: 'tech house', name: 'tech house', aliases: [], umbrellas: [] }]);
});

test('file store: links between genres listed in the same write resolve', async () => {
  const s = await fileStore();
  const change = await s.writeGenreVocabulary(
    [
      { key: 'tech house', image: genre('tech house', { umbrellas: ['house'] }) },
      { key: 'house', image: genre('house') },
    ],
    meta(),
  );
  assert.deepEqual(change.after.map((g) => g.key), ['house', 'tech house']);
});

test('file store: refusals match the database and leave the vocabulary as it was', async () => {
  const s = await fileStore();
  await s.writeGenreVocabulary(
    [
      { key: 'house', image: genre('house', { aliases: [{ key: 'haus', alias: 'Haus' }] }) },
      { key: 'techno', image: genre('techno') },
      { key: 'tech house', image: genre('tech house', { umbrellas: ['house'] }) },
    ],
    meta(),
  );
  const vocab = await s.getGenreVocabulary();
  const changes = (await s.listGenreVocabChanges({})).length;

  await assert.rejects(s.writeGenreVocabulary([{ key: 'house', image: genre('house') }, { key: 'house', image: null }], meta()), /listed twice/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno', { aliases: [{ key: 'house', alias: 'House' }] }) }], meta()), /already a genre key/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno', { aliases: [{ key: 'haus', alias: 'HAUS' }] }) }], meta()), /already an alias of another genre/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'haus', image: genre('haus') }], meta()), /already another genre's alias/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno', { umbrellas: ['techno'] }) }], meta()), /cannot sit under itself/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno', { umbrellas: ['trance'] }) }], meta()), /is not a genre/);
  // house -> tech house -> house is a loop, and so is a longer one through techno.
  await assert.rejects(s.writeGenreVocabulary([{ key: 'house', image: genre('house', { umbrellas: ['tech house'] }) }], meta()), /umbrella loop/);
  await assert.rejects(
    s.writeGenreVocabulary(
      [
        { key: 'techno', image: genre('techno', { umbrellas: ['tech house'] }) },
        { key: 'house', image: genre('house', { umbrellas: ['techno'] }) },
      ],
      meta(),
    ),
    /umbrella loop/,
  );
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno', { name: ' ' }) }], meta()), /needs a name/);
  await assert.rejects(s.writeGenreVocabulary([{ key: ' ', image: genre(' ') }], meta()), /needs a key/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno') }], { ...meta(), reason: ' ' }), /reason and a summary/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno') }], { ...meta(), actor: 'ann' as any }), /actor must be/);
  await assert.rejects(s.writeGenreVocabulary([{ key: 'techno', image: genre('techno') }], { ...meta(), operation: 'nope' as any }), /unknown operation/);

  assert.deepEqual(await s.getGenreVocabulary(), vocab);
  assert.equal((await s.listGenreVocabChanges({})).length, changes);
});

test('file store: an alias may move to another genre in the same write', async () => {
  const s = await fileStore();
  await s.writeGenreVocabulary([{ key: 'house', image: genre('house', { aliases: [{ key: 'haus', alias: 'Haus' }] }) }, { key: 'techno', image: genre('techno') }], meta());
  await s.writeGenreVocabulary(
    [
      { key: 'house', image: genre('house') },
      { key: 'techno', image: genre('techno', { aliases: [{ key: 'haus', alias: 'Haus' }] }) },
    ],
    meta('alias-add'),
  );
  const vocab = await s.getGenreVocabulary();
  assert.deepEqual(vocab.genres.find((g) => g.key === 'techno')?.aliases, [{ key: 'haus', alias: 'Haus' }]);
  assert.deepEqual(vocab.genres.find((g) => g.key === 'house')?.aliases, []);
});

test('file store: a member scope is refused the write, the log and undo; the owner scope is not', async () => {
  const s = await fileStore();
  const ann = s.forUser(ANN);
  await assert.rejects(ann.writeGenreVocabulary([{ key: 'house', image: genre('house') }], meta()), /Only the owner/);
  await assert.rejects(ann.listGenreVocabChanges({}), /Only the owner/);
  await assert.rejects(ann.markGenreVocabChangesUndone(['c1'], '2026-01-01T00:00:00Z'), /Only the owner/);
  assert.deepEqual(await s.getGenreVocabulary(), { genres: [] });
  const owner = s.forUser(OWNER);
  const change = await owner.writeGenreVocabulary([{ key: 'house', image: genre('house') }], meta());
  assert.deepEqual((await owner.listGenreVocabChanges({})).map((c) => c.id), [change.id]);
});

test('supabase store: a member scope is refused the write, the log and undo before any call', async () => {
  const touched: string[] = [];
  const db = new Proxy({}, { get: (_t, prop) => { touched.push(String(prop)); throw new Error('db touched'); } }) as any;
  const ann = new SupabaseLineupStore(db).forUser(ANN);
  await assert.rejects(ann.writeGenreVocabulary([{ key: 'house', image: genre('house') }], meta()), /Only the owner/);
  await assert.rejects(ann.listGenreVocabChanges({}), /Only the owner/);
  await assert.rejects(ann.markGenreVocabChangesUndone(['c1'], '2026-01-01T00:00:00Z'), /Only the owner/);
  assert.deepEqual(touched, []);
});
