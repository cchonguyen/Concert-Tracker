import assert from 'node:assert/strict';
import test from 'node:test';
import { matchEditionName, type CatalogArtist } from '../src/server/canon/nameArtists.ts';

const artist = (name: string): CatalogArtist => ({ key: name.toLowerCase(), name });
const catalog = [artist('Tsha'), artist('Above & Beyond'), artist('Future'), artist('Above'), artist('Sound Nightclub')];

test('a catalog artist at the start of an edition name is matched, quoting the name', () => {
  const m = matchEditionName('Tsha at Sound Nightclub', catalog);
  assert.deepEqual(m, { artistKey: 'tsha', artistName: 'Tsha', quote: 'Tsha at Sound Nightclub' });
});

test('a multi-word artist with an ampersand matches as a whole-word prefix', () => {
  const m = matchEditionName('Above & Beyond Group Therapy', catalog);
  assert.equal(m?.artistKey, 'above & beyond');
});

test('the longest matching prefix wins over a shorter one', () => {
  assert.equal(matchEditionName('Above and Beyond Group Therapy', catalog)?.artistName, 'Above & Beyond');
});

test('a tie between two artists of the same length offers nothing', () => {
  const tied = [artist('Night Owls'), { key: 'night-owls-2', name: 'Night Owls' }];
  assert.equal(matchEditionName('Night Owls Live', tied), null);
});

test('whole words only: an artist is not matched inside a longer word', () => {
  assert.equal(matchEditionName('Futurebeats Festival', catalog), null);
});

test('an artist named in the middle of an edition name is not matched', () => {
  assert.equal(matchEditionName('Summer Tsha Weekend', catalog), null);
});

test('no catalog artist at the start gives no match, and empty names give none', () => {
  assert.equal(matchEditionName('Mystery Show', catalog), null);
  assert.equal(matchEditionName('   ', catalog), null);
  assert.equal(matchEditionName('Tsha', []), null);
});

test('a remainder that is a known series, brand or venue blocks the match', () => {
  const blocked = new Set(['group therapy']);
  assert.equal(matchEditionName('Above & Beyond Group Therapy', catalog, blocked), null);
  assert.equal(matchEditionName('Above & Beyond Group Therapy', catalog, new Set())?.artistName, 'Above & Beyond');
});

test('an exact artist name as the whole edition name matches', () => {
  assert.equal(matchEditionName('Future', catalog)?.artistKey, 'future');
});

test('punctuation and diacritics do not stop a match', () => {
  const m = matchEditionName('TSHÁ: live!', catalog);
  assert.equal(m?.artistName, 'Tsha');
});

test('offersForEditions offers the named catalog act, skips acts already listed, and keeps the blocked remainders', async () => {
  const { offersForEditions } = await import('../src/server/canon/nameArtists.ts');
  const editions = [
    { id: 'e1', name: 'Tsha at Sound Nightclub', performances: [] },
    { id: 'e2', name: 'Tsha at Sound Nightclub', performances: [{ artistKey: 'tsha' }] },
    { id: 'e3', name: 'Above & Beyond Group Therapy', performances: [] },
  ];
  assert.deepEqual(offersForEditions(editions, catalog, new Set(['group therapy'])), [
    { editionId: 'e1', artistKey: 'tsha', artistName: 'Tsha' },
  ]);
});
