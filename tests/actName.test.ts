import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferredSpelling, readActName, yourSpellings } from '../src/server/lineup/actName.ts';
import { mergeLineup } from '../src/server/lineup/merge.ts';
import { PerformerClaim } from '../src/server/lineup/types.ts';

test('a lineup name is read for B2B pairs and a DJ set suffix', () => {
  assert.deepEqual(readActName('Sasha b2b John Digweed'), { parts: ['Sasha', 'John Digweed'], dj: false });
  assert.deepEqual(readActName('Dom Dolla B2B John Summit B2B Mau P'), { parts: ['Dom Dolla', 'John Summit', 'Mau P'], dj: false });
  assert.deepEqual(readActName('Porter Robinson (DJ Set)'), { parts: ['Porter Robinson'], dj: true });
  assert.deepEqual(readActName('Kaskade - DJ set'), { parts: ['Kaskade'], dj: true });
  assert.deepEqual(readActName('Disclosure DJ Set'), { parts: ['Disclosure'], dj: true });
  assert.deepEqual(readActName('DJ Set'), { parts: ['DJ Set'], dj: false }); // nothing left: leave it
  assert.deepEqual(readActName('Bob2B'), { parts: ['Bob2B'], dj: false });
});

test('your spelling wins, else one-case names go to Proper Case', () => {
  const yours = yourSpellings(['deadmau5', 'deadmau5', 'Deadmau5', 'Fred again..']);
  assert.equal(preferredSpelling('DEADMAU5', yours), 'deadmau5');
  assert.equal(preferredSpelling('FRED AGAIN..', yours), 'Fred again..');
  assert.equal(preferredSpelling('JOHN SUMMIT', {}), 'John Summit');
  assert.equal(preferredSpelling('dom dolla', {}), 'Dom Dolla');
  assert.equal(preferredSpelling('MK', {}), 'MK');
  assert.equal(preferredSpelling('deadmau5', {}), 'Deadmau5');
  assert.equal(preferredSpelling('ZHU', {}), 'ZHU');
  assert.equal(preferredSpelling('DJ SNAKE', {}), 'DJ Snake');
  assert.equal(preferredSpelling('KAYTRANADA', {}), 'Kaytranada');
  assert.equal(preferredSpelling('RÜFÜS DU SOL', {}), 'Rüfüs Du Sol');
  assert.equal(preferredSpelling('deadmau5 x Kaskade', {}), 'deadmau5 x Kaskade'); // mixed case kept
});

test('merge splits B2B and DJ set claims, each part cited with the whole quote', () => {
  const claim = (name: string): PerformerClaim => ({
    id: name, jobId: 'j', documentId: 'd', sourceType: 'clashfinder', sourceUrl: 'https://clashfinder.com/s/x/',
    name, quotedSpan: name, evidence: 'crowd', extractor: 'cf', extractorVersion: '1', createdAt: '2025-01-01',
  });
  const lineup = mergeLineup({
    input: { eventName: 'X', year: 2025 }, editionKey: 'x/2025', seriesSlug: 'x', facts: {}, aliases: {}, blocklist: [], stats: [],
    claims: [claim('SASHA b2b John Digweed'), claim('Sasha'), claim('Porter Robinson (DJ Set)')],
    spellings: { sasha: 'Sasha' },
  });
  const by = Object.fromEntries(lineup.performers.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['John Digweed', 'Porter Robinson', 'Sasha']);
  assert.deepEqual(by['Sasha'].b2b, ['john digweed']);
  assert.deepEqual(by['John Digweed'].b2b, ['sasha']);
  assert.equal(by['John Digweed'].sources[0].quotedSpan, 'SASHA b2b John Digweed');
  assert.equal(by['Porter Robinson'].set, 'dj');
  assert.equal(by['Sasha'].set, undefined);
});

test('a set type chosen in review replaces your earlier one; otherwise yours is kept', async () => {
  const { mergeSeen } = await import('../src/server/lineup/learning.ts');
  const before = [{ key: 'kaskade', name: 'Kaskade', from: 'you' as const, set: 'live' as const }];
  const ticked = [{ key: 'kaskade', name: 'Kaskade', from: 'lineup' as const, set: 'dj' as const }];
  assert.equal(mergeSeen(before, ticked, new Set(['kaskade']))[0].set, 'live');
  assert.equal(mergeSeen(before, ticked, new Set(['kaskade']), new Set(['kaskade']))[0].set, 'dj');
  const cleared = [{ key: 'kaskade', name: 'Kaskade', from: 'lineup' as const }];
  assert.equal(mergeSeen(before, cleared, new Set(['kaskade']), new Set(['kaskade']))[0].set, undefined);
});
