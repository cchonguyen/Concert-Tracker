import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtistGenres, GenreMapEntry, GenreVocabulary, VocabGenre } from '../src/server/events/genreTypes.ts';
import {
  genreCollisions,
  genreKey,
  genreResolver,
  genresUnder,
  isValidGenreName,
  resolveGenre,
  resolveShares,
  umbrellaClosure,
  umbrellasOf,
  wouldMakeUmbrellaLoop,
} from '../src/server/events/genreVocabulary.ts';

const row = (key: string, styles: Array<[string, string]>, source: ArtistGenres['source'] = 'music-story'): ArtistGenres => ({
  key,
  name: key,
  source,
  genres: styles.map(([style, parent]) => ({ style, parent, weight: 1 / styles.length })),
  checkedAt: '2026-11-26T00:00:00Z',
});

const vg = (key: string, name: string, extra: Partial<VocabGenre> = {}): VocabGenre => ({
  key,
  name,
  aliases: [],
  umbrellas: [],
  ...extra,
});

const MAP: GenreMapEntry[] = [
  { tag: 'electro house', style: 'electro house', parent: 'electronic' },
  { tag: 'house', style: 'house', parent: 'electronic' },
  { tag: 'tech house', style: 'tech house', parent: 'electronic' },
  { tag: 'hip hop', style: 'hip hop', parent: 'hip hop' },
  { tag: 'rock', style: 'rock', parent: 'rock' },
];

test('genreKey: the spec table, same genre', () => {
  for (const s of ['electro house', 'Electro-House', 'electrohouse', 'electro_house']) assert.equal(genreKey(s), 'electrohouse');
  for (const s of ['hip hop', 'Hip-Hop', 'hiphop']) assert.equal(genreKey(s), 'hiphop');
  assert.equal(genreKey('R&B'), 'rb');
  assert.equal(genreKey('r & b'), 'rb');
  assert.equal(genreKey('2-step'), '2step');
  assert.equal(genreKey('2 step'), '2step');
});

test('genreKey: the spec table, never joins', () => {
  assert.notEqual(genreKey('R&B'), genreKey('rnb'));
  assert.equal(genreKey('drum and bass'), 'drumandbass');
  assert.equal(genreKey('drum & bass'), 'drumbass');
  assert.equal(genreKey('dnb'), 'dnb');
  assert.equal(new Set([genreKey('drum and bass'), genreKey('drum & bass'), genreKey('dnb')]).size, 3);
  assert.equal(genreKey('house'), 'house');
  assert.equal(genreKey('houses'), 'houses');
  assert.notEqual(genreKey('hip hop'), genreKey('rap'));
  assert.notEqual(genreKey('rock music'), genreKey('rock'));
  assert.notEqual(genreKey('house techno'), genreKey('techno house'));
  assert.notEqual(genreKey('drum + bass'), genreKey('drum and bass'));
});

test('genreKey: accents fold, punctuation and brackets go', () => {
  assert.equal(genreKey('électro'), genreKey('electro'));
  assert.equal(genreKey('Électro House'), 'electrohouse');
  assert.equal(genreKey("rock 'n' roll"), 'rocknroll');
  assert.equal(genreKey('nu-disco (live)'), 'nudiscolive');
  assert.equal(genreKey('a.b/c+d'), 'abcd');
});

test('a style with no letter or digit has an empty key and is refused', () => {
  assert.equal(genreKey('!!!'), '');
  assert.equal(genreKey('-'), '');
  assert.equal(isValidGenreName('!!!'), false);
  assert.equal(isValidGenreName(' - '), false);
  assert.equal(isValidGenreName('2'), true);
});

test('resolveGenre: with no vocabulary, the map spelling and parent', () => {
  assert.deepEqual(resolveGenre('Electro-House', undefined, MAP), { key: 'electrohouse', name: 'electro house', parent: 'electronic' });
  assert.deepEqual(resolveGenre('HIPHOP', { genres: [] }, MAP), { key: 'hiphop', name: 'hip hop', parent: 'hip hop' });
});

test('resolveGenre: a vocabulary genre and its aliases', () => {
  const vocab: GenreVocabulary = {
    genres: [vg('drumandbass', 'drum and bass', { parent: 'electronic', aliases: [{ key: 'dnb', alias: 'DnB' }, { key: 'drumbass', alias: 'drum & bass' }] })],
  };
  for (const s of ['Drum and Bass', 'DNB', 'drum & bass', 'Drum-&-Bass']) {
    assert.deepEqual(resolveGenre(s, vocab, MAP), { key: 'drumandbass', name: 'drum and bass', parent: 'electronic' });
  }
  // A key that is neither a genre nor an alias stays its own genre.
  assert.equal(resolveGenre('d n b x', vocab, MAP).key, 'dnbx');
});

test('resolveGenre: the owner chosen spelling wins over the map', () => {
  const vocab: GenreVocabulary = { genres: [vg('electrohouse', 'Electro House')] };
  assert.deepEqual(resolveGenre('electrohouse', vocab, MAP), { key: 'electrohouse', name: 'Electro House', parent: 'electronic' });
});

test('shown spelling: map, then most shared rows, then first alphabetically; members never count', () => {
  const rows = [
    row('a', [['Future Bass', 'electronic']]),
    row('b', [['future-bass', 'electronic']]),
    row('c', [['future-bass', 'electronic']]),
    row('d', [['Future Bass', 'electronic']], 'added'),
    row('e', [['Future Bass', 'electronic']], 'added'),
  ];
  assert.equal(resolveGenre('futurebass', undefined, MAP, rows).name, 'future-bass');
  const tie = [row('a', [['Zed', 'rock']]), row('b', [['ZED', 'rock']])];
  assert.equal(resolveGenre('zed', undefined, MAP, tie).name, 'ZED');
  // The map beats rows even when rows use another spelling more.
  const many = [row('a', [['Electro-House', 'electronic']]), row('b', [['Electro-House', 'electronic']])];
  assert.equal(resolveGenre('electrohouse', undefined, MAP, many).name, 'electro house');
  // Typed, unknown: its own trimmed spelling.
  assert.equal(resolveGenre('  Hyperpop ', undefined, MAP).name, 'Hyperpop');
});

test('group: owner, then map, then shared rows if a map group, else none (Not grouped)', () => {
  const vocab: GenreVocabulary = { genres: [vg('house', 'house', { parent: 'rock' })] };
  assert.equal(resolveGenre('house', vocab, MAP).parent, 'rock');
  assert.equal(resolveGenre('house', undefined, MAP).parent, 'electronic');
  const rows = [row('a', [['hyperpop', 'electronic']]), row('b', [['hyperpop', 'electronic']]), row('c', [['hyperpop', 'rock']])];
  assert.equal(resolveGenre('Hyperpop', undefined, MAP, rows).parent, 'electronic');
  // A made-up genre that is its own parent is not a map group: Not grouped.
  const own = [row('a', [['bloghouse', 'bloghouse']])];
  assert.equal(resolveGenre('bloghouse', undefined, MAP, own).parent, undefined);
  assert.ok(!('parent' in resolveGenre('nothing known', undefined, MAP)));
  // A merged genre falls back to the map parent of its aliases.
  const merged: GenreVocabulary = { genres: [vg('electrohaus', 'electro haus', { aliases: [{ key: 'electrohouse', alias: 'electro house' }] })] };
  assert.equal(resolveGenre('electro house', merged, MAP).parent, 'electronic');
  assert.deepEqual(genreResolver(undefined, MAP).groups, ['electronic', 'hip hop', 'rock']);
});

test('resolveShares: styles of the same genre in one act add their weights', () => {
  const r = genreResolver(undefined, MAP);
  const out = resolveShares(
    [
      { style: 'electro house', parent: 'electronic', weight: 0.5 },
      { style: 'Electro-House', parent: 'electronic', weight: 0.25 },
      { style: 'made up', parent: 'made up', weight: 0.25 },
      { style: '!!!', parent: 'x', weight: 0 },
    ],
    r,
  );
  assert.deepEqual(out, [
    { style: 'electro house', parent: 'electronic', weight: 0.75 },
    { style: 'made up', parent: 'Not grouped', weight: 0.25 },
  ]);
});

test('umbrellas nest; closure at any depth; loops refused and never hang', () => {
  const vocab: GenreVocabulary = {
    genres: [
      vg('techhouse', 'tech house', { umbrellas: ['house'] }),
      vg('electrohouse', 'electro house', { umbrellas: ['house', 'electro'] }),
      vg('house', 'house', { umbrellas: ['dancemusic'] }),
      vg('electro', 'electro', { umbrellas: ['dancemusic'] }),
      vg('dancemusic', 'dance music'),
    ],
  };
  assert.deepEqual([...umbrellasOf('electrohouse', vocab)].sort(), ['dancemusic', 'electro', 'house']);
  assert.deepEqual([...genresUnder('dancemusic', vocab)].sort(), ['electro', 'electrohouse', 'house', 'techhouse']);
  assert.deepEqual([...genresUnder('house', vocab)].sort(), ['electrohouse', 'techhouse']);
  assert.equal(wouldMakeUmbrellaLoop('dancemusic', 'techhouse', vocab), true);
  assert.equal(wouldMakeUmbrellaLoop('house', 'house', vocab), true);
  assert.equal(wouldMakeUmbrellaLoop('techhouse', 'electro', vocab), false);
  const looped: GenreVocabulary = { genres: [vg('a', 'a', { umbrellas: ['b'] }), vg('b', 'b', { umbrellas: ['a'] })] };
  const c = umbrellaClosure(looped);
  assert.deepEqual([...c.get('a')!], ['b']);
  assert.deepEqual([...c.get('b')!], ['a']);
});

test('genreCollisions: keys with two spellings, no chosen spelling; never different keys', () => {
  const rows = [
    row('a', [['Electro-House', 'electronic']]),
    row('b', [['Electro-House', 'electronic'], ['drum & bass', 'electronic']]),
    row('c', [['electrohouse', 'electronic'], ['drum and bass', 'electronic']]),
    row('d', [['Hip-Hop', 'hip hop']]),
    row('e', [['HIP HOP', 'hip hop']], 'added'),
  ];
  const out = genreCollisions(rows, undefined, MAP);
  assert.deepEqual(out, [
    {
      key: 'electrohouse',
      spellings: [
        { name: 'Electro-House', artists: 2 },
        { name: 'electrohouse', artists: 1 },
        { name: 'electro house', artists: 0 },
      ],
      shown: 'electro house',
    },
    { key: 'hiphop', spellings: [{ name: 'Hip-Hop', artists: 1 }, { name: 'hip hop', artists: 0 }], shown: 'hip hop' },
  ]);
  const picked: GenreVocabulary = { genres: [vg('electrohouse', 'Electro-House')] };
  assert.deepEqual(genreCollisions(rows, picked, MAP).map((c) => c.key), ['hiphop']);
  const aliased: GenreVocabulary = { genres: [vg('rap', 'rap', { aliases: [{ key: 'hiphop', alias: 'hip hop' }] })] };
  assert.deepEqual(genreCollisions(rows, aliased, MAP).map((c) => c.key), ['electrohouse']);
});
