import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNonMusicProgramming,
  isSilentDiscoSlot,
  preferredSpelling,
  readActName,
  yourSpellings,
} from '../src/server/lineup/actName.ts';
import { mergeLineup } from '../src/server/lineup/merge.ts';
import { PerformerClaim } from '../src/server/lineup/types.ts';

test('a lineup name is read for B2B pairs and a DJ set suffix', () => {
  assert.deepEqual(readActName('Sasha b2b John Digweed'), { parts: ['Sasha', 'John Digweed'] });
  assert.deepEqual(readActName('Dom Dolla B2B John Summit B2B Mau P'), { parts: ['Dom Dolla', 'John Summit', 'Mau P'] });
  assert.deepEqual(readActName('A b2b B b2b C'), { parts: ['A', 'B', 'C'] });
  assert.deepEqual(readActName('Cirez D vs Adam Beyer'), { parts: ['Cirez D', 'Adam Beyer'] });
  assert.deepEqual(readActName('Cirez D vs. Adam Beyer'), { parts: ['Cirez D', 'Adam Beyer'] });
  assert.deepEqual(readActName('Armin van Buuren x Adam Beyer'), { parts: ['Armin van Buuren', 'Adam Beyer'] });
  assert.deepEqual(readActName('RL Grime X Knock2'), { parts: ['RL Grime', 'Knock2'] });
  assert.deepEqual(readActName('Skrillex x Four Tet x Fred again..'), { parts: ['Skrillex', 'Four Tet', 'Fred again..'] });
  assert.deepEqual(readActName('Porter Robinson (DJ Set)'), { parts: ['Porter Robinson'], set: 'DJ Set' });
  assert.deepEqual(readActName('Kaskade - DJ set'), { parts: ['Kaskade'], set: 'DJ Set' });
  assert.deepEqual(readActName('Disclosure DJ Set'), { parts: ['Disclosure'], set: 'DJ Set' });
  assert.deepEqual(readActName('DJ Set'), { parts: ['DJ Set'] }); // nothing left: leave it
  assert.deepEqual(readActName('Bob2B'), { parts: ['Bob2B'] });
  assert.deepEqual(readActName('Skrillex B3B Four Tet B3B Fred again..'), { parts: ['Skrillex', 'Four Tet', 'Fred again..'] });
  assert.deepEqual(readActName('Artist A b/3/b Artist B'), { parts: ['Artist A', 'Artist B'] });
  assert.deepEqual(readActName('Artist A b4b Artist B'), { parts: ['Artist A', 'Artist B'] });
  assert.deepEqual(readActName('Artist A b2b2b Artist B'), { parts: ['Artist A', 'Artist B'] });
  assert.deepEqual(readActName('Artist A back to back Artist B'), { parts: ['Artist A', 'Artist B'] });
  assert.deepEqual(readActName('Artist A back-to-back Artist B'), { parts: ['Artist A', 'Artist B'] });
});

test('readActName extracts set suffixes across parentheses, presents, and clashfinder delimiters', () => {
  // Trailing parenthetical & bracketed concepts
  assert.deepEqual(readActName('Bicep (Live)'), { parts: ['Bicep'], set: 'Live' });
  assert.deepEqual(readActName('Bicep (Live Set)'), { parts: ['Bicep'], set: 'Live' });
  assert.deepEqual(readActName('Tiësto (Sunrise Set)'), { parts: ['Tiësto'], set: 'Sunrise Set' });
  assert.deepEqual(readActName('Seven Lions [100% 128 Set]'), { parts: ['Seven Lions'], set: '100% 128 Set' });

  // Presents / Pres. connector
  assert.deepEqual(readActName('Adventure Club presents Throwback Set'), { parts: ['Adventure Club'], set: 'Throwback Set' });
  assert.deepEqual(readActName('Eric Prydz pres. HOLO'), { parts: ['Eric Prydz'], set: 'HOLO' });
  assert.deepEqual(readActName('Eric Prydz presents HOLO'), { parts: ['Eric Prydz'], set: 'HOLO' });

  // Clashfinder colon / hyphen suffix with whitelist keywords
  assert.deepEqual(readActName('Kaskade: Redux'), { parts: ['Kaskade'], set: 'Redux' });
  assert.deepEqual(readActName('Bonobo - Live'), { parts: ['Bonobo'], set: 'Live' });
  assert.deepEqual(readActName('Above & Beyond - Acoustic'), { parts: ['Above & Beyond'], set: 'Acoustic' });
  assert.deepEqual(readActName('Above & Beyond: Acoustic'), { parts: ['Above & Beyond'], set: 'Acoustic' });
  assert.deepEqual(readActName('Swedish House Mafia - 360'), { parts: ['Swedish House Mafia'], set: '360' });

  // Disambiguation ISO country code guard
  assert.deepEqual(readActName('Transmission (UK)'), { parts: ['Transmission (UK)'] });
  assert.deepEqual(readActName('Alix Perez (BE)'), { parts: ['Alix Perez (BE)'] });
  assert.deepEqual(readActName('Phoenix (FR)'), { parts: ['Phoenix (FR)'] });
  assert.deepEqual(readActName('Air (FR)'), { parts: ['Air (FR)'] });

  // B2B with set modifier stripped first
  assert.deepEqual(readActName('Slander b2b NGHTMRE (Gud Vibrations)'), {
    parts: ['Slander', 'NGHTMRE'],
    set: 'Gud Vibrations',
  });
  assert.deepEqual(readActName('Dom Dolla b2b John Summit (Everything Always)'), {
    parts: ['Dom Dolla', 'John Summit'],
    set: 'Everything Always',
  });

  // Hyphenated and colon artist names preserved without false positive set extraction
  assert.deepEqual(readActName('Jay-Z'), { parts: ['Jay-Z'] });
  assert.deepEqual(readActName('BLOND:ISH'), { parts: ['BLOND:ISH'] });
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
  assert.equal(by['Porter Robinson'].set, 'DJ Set');
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

test('non-music programming and placeholder slots are detected', () => {
  // Coachella 2025 samples
  assert.equal(isNonMusicProgramming('Awaken Flow Yoga with Allison Delgado'), true);
  assert.equal(isNonMusicProgramming('Bass Restore with Lexia Wills'), true);
  assert.equal(isNonMusicProgramming('Buti Yoga w/ Lexia Wills'), true);
  assert.equal(isNonMusicProgramming('Campgrounds 5K w/ Lyo Reneau'), true);
  assert.equal(isNonMusicProgramming('Chew On This w/ Chef Priyanka Naik'), true);
  assert.equal(isNonMusicProgramming('Grassroots Activism w/ Rep Maxwell Frost & Rep Justin Jones'), true);
  assert.equal(isNonMusicProgramming('High Noon Water Balloon Fight'), true);
  assert.equal(isNonMusicProgramming('Polar Bear Dating Game'), true);
  assert.equal(isNonMusicProgramming('Rockstar Workout w/ Erica Hood'), true);
  assert.equal(isNonMusicProgramming('Sound Bath w/ Stephanie Lyons'), true);
  assert.equal(isNonMusicProgramming('What\'s The Price? (win VIP upgrade!)'), true);
  assert.equal(isNonMusicProgramming('(Surprise)'), true);
  assert.equal(isNonMusicProgramming('TBA'), true);

  // Coachella 2023 samples
  assert.equal(isNonMusicProgramming('Breaking Up with Plastic: Learn How To Cut Out Single Use Plastic With Dr. Emma Cohen'), true);
  assert.equal(isNonMusicProgramming('Chef Priyanka Naik (Chef/Author/TV Host): Become an Ecokitchen Warrior'), true);
  assert.equal(isNonMusicProgramming('Dr. Anjali Tripathi (NASA): I Can Show You the Worlds - Stories About the Search for Life and Other Planets'), true);
  assert.equal(isNonMusicProgramming('Dr. Ben Hamlington (Research Scientist, Sea Level and Ice Group): Bad Moon Rising - How the Moon\'s Wobble Can Make Sea Level Rise Worse'), true);
  assert.equal(isNonMusicProgramming('Congressman Maxwell Frost (First Get Z Member in Congress): Bridging the Gap Between Cool & Conscious'), true);
  assert.equal(isNonMusicProgramming('DJ Megatone and the Camp City Breakers: JWolf, Nico, Jojo, Stampede, Dishon, LuvBugJune'), true);
  assert.equal(isNonMusicProgramming('Jaden Smith (Artist) and Drew FitzGerald (501cThree): Waterworld - The Battle for the World\'s Greatest Resource Moderated by Congressman Maxwell Frost'), true);
  assert.equal(isNonMusicProgramming('Leah Thomas (Intersectional Environmentalist), Sophia Kianni (Climate Cardinals) and Phoebe Gates (Healthcare & Sustainability Activist): The Power of Women in Advancing Sustainability'), true);
  assert.equal(isNonMusicProgramming('Seeing the Stars at Coachella: Stargazing w/NASA\'s Exoplanet Ambassador Dr. Anjali Tripathi & Friends'), true);
  assert.equal(isNonMusicProgramming('The Future of Food: Insects Are the Headlines at Every Dinner Table With MacKenzie Wade'), true);
  assert.equal(isNonMusicProgramming('UMI (Artist): Earth Care & Self Care Moderated by Leah Thomas (Intersectional Environmentalist)'), true);

  // Real music artists are not rejected
  assert.equal(isNonMusicProgramming('Bad Bunny'), false);
  assert.equal(isNonMusicProgramming('BLACKPINK'), false);
  assert.equal(isNonMusicProgramming('Frank Ocean'), false);
  assert.equal(isNonMusicProgramming('Blink-182'), false);
  assert.equal(isNonMusicProgramming('Gorillaz'), false);
  assert.equal(isNonMusicProgramming('Green Day'), false);
  assert.equal(isNonMusicProgramming('Post Malone'), false);
  assert.equal(isNonMusicProgramming('Charli xcx'), false);
  assert.equal(isNonMusicProgramming('Chris Lake'), false);
  assert.equal(isNonMusicProgramming('Kaleena Zanders'), false);
});

test('silent disco channel slots are detected', () => {
  assert.equal(isSilentDiscoSlot('CH 1: DJ Mish; CH 2: Minimize'), true);
  assert.equal(isSilentDiscoSlot('CH 1: Hitman; CH 2: Athena'), true);
  assert.equal(isSilentDiscoSlot('CH 1: demonslayer ; CH 2: Tombz'), true);
  assert.equal(isSilentDiscoSlot('CH 1: Danni G; CH 2: Fernet'), true);
  assert.equal(isSilentDiscoSlot('CH 1: Secret Guest!; CH 2: GOJ!RA'), true);

  // Normal acts are not silent disco
  assert.equal(isSilentDiscoSlot('DJ Mish'), false);
  assert.equal(isSilentDiscoSlot('Sasha b2b John Digweed'), false);
});

test('readActName cleans concept prefixes and unmatched parentheses', () => {
  const read = readActName(
    'Sara Landry presents Blood Oath (Indira Paganotto b2b Sara Landry b2b Amelie Lens)'
  );
  assert.deepEqual(read.parts, ['Indira Paganotto', 'Sara Landry', 'Amelie Lens']);

  const dangling = readActName('Artist A (Solo b2b Artist B)');
  assert.deepEqual(dangling.parts, ['Solo', 'Artist B']);
});

test('mergeLineup drops non-music and silent disco claims', () => {
  const claim = (name: string): PerformerClaim => ({
    id: name,
    jobId: 'j',
    documentId: 'd',
    sourceType: 'clashfinder',
    sourceUrl: 'https://clashfinder.com/s/x/',
    name,
    quotedSpan: name,
    evidence: 'crowd',
    extractor: 'cf',
    extractorVersion: '1',
    createdAt: '2025-01-01',
  });
  const lineup = mergeLineup({
    input: { eventName: 'X', year: 2025 },
    editionKey: 'x/2025',
    seriesSlug: 'x',
    facts: {},
    aliases: {},
    blocklist: [],
    stats: [],
    claims: [
      claim('Green Day'),
      claim('Awaken Flow Yoga with Allison Delgado'),
      claim('CH 1: DJ Mish; CH 2: Minimize'),
      claim('(Surprise)'),
      claim('Post Malone'),
    ],
  });
  assert.equal(lineup.performers.length, 2);
  assert.deepEqual(lineup.performers.map((p) => p.name).sort(), ['Green Day', 'Post Malone']);
  assert.equal(lineup.droppedCount, 3);
});
