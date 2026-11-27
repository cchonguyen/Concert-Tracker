import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GenreMapEntry, GenreVocabulary, VocabGenre } from '../src/server/events/genreTypes.ts';
import {
  checkTaxonomy,
  familyKey,
  genreKey,
  levelOf,
  macroKey,
  resolveGenre,
} from '../src/server/events/genreVocabulary.ts';

const vg = (key: string, name: string, extra: Partial<VocabGenre> = {}): VocabGenre => ({
  key,
  name,
  aliases: [],
  umbrellas: [],
  ...extra,
});

const MACRO_ELEC = macroKey('Electronic');
const FAM_HOUSE = familyKey('House');

// A small valid tree: Electronic (macro) > House (family) > tech house (genre, alias Tech-House).
function tree(): GenreVocabulary {
  return {
    genres: [
      vg(MACRO_ELEC, 'Electronic', { level: 'macro' }),
      vg(FAM_HOUSE, 'House', { level: 'family', primaryParent: MACRO_ELEC }),
      vg('techhouse', 'tech house', {
        primaryParent: FAM_HOUSE,
        tier: 'specific',
        aliases: [{ key: genreKey('Tech-House'), alias: 'Tech-House' }],
      }),
    ],
  };
}

// The stored row parent "Dance" is a group from the old music-story split. It must
// never supply a family or a macro.
const MAP: GenreMapEntry[] = [{ tag: 'techhouse', style: 'techhouse', parent: 'Dance' }];

test('a style resolves through its alias to the genre, its family, its macro and its tier', () => {
  const r = resolveGenre('Tech-House', tree(), MAP);
  assert.equal(r.key, 'techhouse');
  assert.equal(r.name, 'tech house');
  assert.deepEqual(r.family, { key: FAM_HOUSE, name: 'House' });
  assert.deepEqual(r.macro, { key: MACRO_ELEC, name: 'Electronic' });
  assert.equal(r.tier, 'specific');
});

test('the stored row parent is ignored for family and macro', () => {
  const plain: GenreVocabulary = { genres: [vg('techhouse', 'tech house')] };
  const r = resolveGenre('techhouse', plain, MAP);
  assert.equal(r.parent, 'Dance', 'the existing parent is unchanged');
  assert.equal(r.family, undefined);
  assert.equal(r.macro, undefined);
});

test('a genre with no primary parent has no family or macro', () => {
  const v: GenreVocabulary = { genres: [vg('ambient', 'ambient')] };
  const r = resolveGenre('Ambient', v, []);
  assert.equal(r.family, undefined);
  assert.equal(r.macro, undefined);
  assert.equal(r.tier, undefined);
});

test('a family whose primary parent is not a macro gives a family but no macro', () => {
  const v: GenreVocabulary = {
    genres: [
      vg('family:house', 'House', { level: 'family', primaryParent: 'dance' }),
      vg('dance', 'Dance'),
      vg('techhouse', 'tech house', { primaryParent: 'family:house' }),
    ],
  };
  const r = resolveGenre('techhouse', v, []);
  assert.deepEqual(r.family, { key: 'family:house', name: 'House' });
  assert.equal(r.macro, undefined);
});

test('a family named House and a genre named house coexist and house resolves to the genre', () => {
  const v: GenreVocabulary = {
    genres: [
      vg(MACRO_ELEC, 'Electronic', { level: 'macro' }),
      vg(FAM_HOUSE, 'House', { level: 'family', primaryParent: MACRO_ELEC }),
      vg('house', 'house', { primaryParent: FAM_HOUSE }),
    ],
  };
  assert.notEqual(FAM_HOUSE, 'house');
  const r = resolveGenre('house', v, []);
  assert.equal(r.key, 'house');
  assert.equal(r.name, 'house');
  assert.deepEqual(r.family, { key: FAM_HOUSE, name: 'House' });
});

test('a typed family spelling never resolves to the family row', () => {
  const r = resolveGenre('family:house', tree(), []);
  assert.equal(r.key, 'familyhouse');
  assert.equal(r.family, undefined);
  assert.equal(r.macro, undefined);
});

test('an alias that points at a family key does not resolve to the family', () => {
  const v: GenreVocabulary = {
    genres: [
      vg(MACRO_ELEC, 'Electronic', { level: 'macro' }),
      vg(FAM_HOUSE, 'House', {
        level: 'family',
        primaryParent: MACRO_ELEC,
        aliases: [{ key: 'housey', alias: 'Housey' }],
      }),
    ],
  };
  const r = resolveGenre('Housey', v, []);
  assert.notEqual(r.key, FAM_HOUSE);
  assert.equal(levelOf(v.genres[1]), 'family');
});

test('levelOf defaults to genre and familyKey and macroKey add their prefix', () => {
  assert.equal(levelOf({}), 'genre');
  assert.equal(levelOf({ level: 'family' }), 'family');
  assert.equal(familyKey('Tech House'), 'family:techhouse');
  assert.equal(macroKey('Electronic'), 'macro:electronic');
});

test('checkTaxonomy accepts a valid tree', () => {
  assert.deepEqual(checkTaxonomy(tree()), []);
});

test('checkTaxonomy: a genre whose primary parent is not a family is refused', () => {
  const v: GenreVocabulary = {
    genres: [vg('dance', 'Dance', { level: 'genre' }), vg('techhouse', 'tech house', { primaryParent: 'dance' })],
  };
  assert.match(checkTaxonomy(v).join('\n'), /primary parent must be a family/);
  const ok: GenreVocabulary = {
    genres: [vg(FAM_HOUSE, 'House', { level: 'family', primaryParent: MACRO_ELEC }), vg(MACRO_ELEC, 'Electronic', { level: 'macro' }), vg('techhouse', 'tech house', { primaryParent: FAM_HOUSE })],
  };
  assert.deepEqual(checkTaxonomy(ok), []);
});

test('checkTaxonomy: a genre whose primary parent does not exist is refused', () => {
  const v: GenreVocabulary = { genres: [vg('techhouse', 'tech house', { primaryParent: 'family:nope' })] };
  assert.match(checkTaxonomy(v).join('\n'), /does not exist/);
});

test('checkTaxonomy: a family whose primary parent is not a macro is refused', () => {
  const bad: GenreVocabulary = {
    genres: [vg(FAM_HOUSE, 'House', { level: 'family', primaryParent: FAM_HOUSE })],
  };
  assert.match(checkTaxonomy(bad).join('\n'), /must be a macro/);
  assert.deepEqual(checkTaxonomy(tree()), []);
});

test('checkTaxonomy: a family with no macro is refused', () => {
  const v: GenreVocabulary = { genres: [vg(FAM_HOUSE, 'House', { level: 'family' })] };
  assert.match(checkTaxonomy(v).join('\n'), /needs a primary parent that is a macro/);
});

test('checkTaxonomy: a macro with a primary parent is refused', () => {
  const v: GenreVocabulary = {
    genres: [vg(MACRO_ELEC, 'Electronic', { level: 'macro', primaryParent: MACRO_ELEC })],
  };
  assert.match(checkTaxonomy(v).join('\n'), /a macro has no primary parent/);
  assert.deepEqual(checkTaxonomy({ genres: [vg(MACRO_ELEC, 'Electronic', { level: 'macro' })] }), []);
});

test('checkTaxonomy: a genre cannot be its own primary parent', () => {
  const v: GenreVocabulary = { genres: [vg('house', 'house', { primaryParent: 'house' })] };
  assert.match(checkTaxonomy(v).join('\n'), /own primary parent/);
});

test('checkTaxonomy: key space is enforced for each level', () => {
  const genreWithColon: GenreVocabulary = { genres: [vg('a:b', 'a:b')] };
  assert.match(checkTaxonomy(genreWithColon).join('\n'), /wrong key space/);
  const badFamily: GenreVocabulary = {
    genres: [vg('house', 'House', { level: 'family', primaryParent: MACRO_ELEC }), vg(MACRO_ELEC, 'Electronic', { level: 'macro' })],
  };
  assert.match(checkTaxonomy(badFamily).join('\n'), /family.*wrong key space/);
  const badMacro: GenreVocabulary = { genres: [vg('electronic', 'Electronic', { level: 'macro' })] };
  assert.match(checkTaxonomy(badMacro).join('\n'), /macro.*wrong key space/);
  assert.deepEqual(checkTaxonomy({ genres: [vg('house', 'house')] }), []);
});

test('checkTaxonomy: a tier is allowed only on a genre', () => {
  const onFamily: GenreVocabulary = {
    genres: [vg(FAM_HOUSE, 'House', { level: 'family', primaryParent: MACRO_ELEC, tier: 'specific' }), vg(MACRO_ELEC, 'Electronic', { level: 'macro' })],
  };
  assert.match(checkTaxonomy(onFamily).join('\n'), /only a genre has a tier/);
  const onGenre: GenreVocabulary = { genres: [vg('ambient', 'ambient', { tier: 'umbrella_fallback' })] };
  assert.deepEqual(checkTaxonomy(onGenre), []);
});

test('checkTaxonomy: a secondary_parent must point at a family', () => {
  const v = tree();
  v.genres[2].relations = [{ target: 'techhouse', type: 'secondary_parent', weight: 1, origin: 'curated' }];
  assert.match(checkTaxonomy(v).join('\n'), /secondary_parent points at a family/);
  const ok = tree();
  ok.genres[2].relations = [{ target: FAM_HOUSE, type: 'secondary_parent', weight: 1, origin: 'curated' }];
  assert.deepEqual(checkTaxonomy(ok), []);
});

test('checkTaxonomy: adjacent and derived_from must point at a genre', () => {
  const v = tree();
  v.genres[2].relations = [{ target: FAM_HOUSE, type: 'adjacent', weight: 0.5, origin: 'artist_cooccur' }];
  assert.match(checkTaxonomy(v).join('\n'), /adjacent points at a genre/);
  const ok = tree();
  ok.genres.push(vg('ambient', 'ambient'));
  ok.genres[2].relations = [{ target: 'ambient', type: 'adjacent', weight: 0.5, origin: 'artist_cooccur' }];
  assert.deepEqual(checkTaxonomy(ok), []);
});

test('checkTaxonomy: a relation target must exist', () => {
  const v = tree();
  v.genres[2].relations = [{ target: 'ghost', type: 'adjacent', weight: 0.5, origin: 'curated' }];
  assert.match(checkTaxonomy(v).join('\n'), /target ghost does not exist/);
});

test('checkTaxonomy: a relation cannot point at itself', () => {
  const v = tree();
  v.genres[2].relations = [{ target: 'techhouse', type: 'adjacent', weight: 0.5, origin: 'curated' }];
  assert.match(checkTaxonomy(v).join('\n'), /cannot point at itself/);
});

test('checkTaxonomy: a relation weight must be in (0, 1]', () => {
  for (const weight of [0, -0.1, 1.2, Number.NaN]) {
    const v = tree();
    v.genres.push(vg('ambient', 'ambient'));
    v.genres[2].relations = [{ target: 'ambient', type: 'adjacent', weight, origin: 'curated' }];
    assert.match(checkTaxonomy(v).join('\n'), /outside \(0, 1\]/, `weight ${weight}`);
  }
  const ok = tree();
  ok.genres.push(vg('ambient', 'ambient'));
  ok.genres[2].relations = [{ target: 'ambient', type: 'adjacent', weight: 1, origin: 'curated' }];
  assert.deepEqual(checkTaxonomy(ok), []);
});

test('checkTaxonomy: an adjacent pair stored in both directions is refused', () => {
  const v = tree();
  v.genres.push(vg('ambient', 'ambient'));
  v.genres[2].relations = [{ target: 'ambient', type: 'adjacent', weight: 0.5, origin: 'artist_cooccur' }];
  v.genres[3].relations = [{ target: 'techhouse', type: 'adjacent', weight: 0.5, origin: 'artist_cooccur' }];
  assert.match(checkTaxonomy(v).join('\n'), /both directions/);
});

test('checkTaxonomy: a derived_from loop is refused and a chain is allowed', () => {
  const loop = tree();
  loop.genres.push(vg('ambient', 'ambient'));
  loop.genres[2].relations = [{ target: 'ambient', type: 'derived_from', weight: 1, origin: 'curated' }];
  loop.genres[3].relations = [{ target: 'techhouse', type: 'derived_from', weight: 1, origin: 'curated' }];
  assert.match(checkTaxonomy(loop).join('\n'), /makes a loop/);

  const chain = tree();
  chain.genres.push(vg('ambient', 'ambient'));
  chain.genres[2].relations = [{ target: 'ambient', type: 'derived_from', weight: 1, origin: 'curated' }];
  assert.deepEqual(checkTaxonomy(chain), []);
});

test('checkTaxonomy: an unknown relation type or origin is refused', () => {
  const v = tree();
  v.genres[2].relations = [
    { target: FAM_HOUSE, type: 'cousin' as never, weight: 1, origin: 'curated' },
    { target: FAM_HOUSE, type: 'secondary_parent', weight: 1, origin: 'user_cooccur' as never },
  ];
  const errors = checkTaxonomy(v).join('\n');
  assert.match(errors, /unknown type "cousin"/);
  assert.match(errors, /unknown origin "user_cooccur"/);
});
