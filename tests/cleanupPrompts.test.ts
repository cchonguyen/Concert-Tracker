import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIST_CLEANUP_AI_PROMPT, GENRES_CSV_AI_PROMPT } from '../src/services/cleanupPrompts.ts';

test('ARTIST_CLEANUP_AI_PROMPT documents all 15 columns, 6 statuses, and key rules', () => {
  for (const token of [
    'Artist,MusicBrainz ID,Source,Version (leave as it is),Entity_Status,Invalid_Reason,Canonical_Artist,Canonical_Key,Set_Qualifier,Split_Artists,Split_Keys,Combo_Alias,Alter_Ego_Of,Alter_Ego_Of_Key,Cleanup_Notes',
    'invalid_non_artist',
    'merge_duplicate',
    'remap_set',
    'split_multi_artist',
    'rename',
    'link_alter_ego',
    'mbid:<uuid>',
    'artist:<Exact Original Artist>',
    'NEW',
    '\\xa0',
  ]) {
    assert.ok(ARTIST_CLEANUP_AI_PROMPT.includes(token), `missing ${token}`);
  }
});

test('GENRES_CSV_AI_PROMPT documents all 6 columns and formatting constraints', () => {
  for (const token of [
    'Artist,MusicBrainz ID,Current genres,Source,New genres,Version (leave as it is)',
    '; ',
    '10',
    '60',
    'none',
  ]) {
    assert.ok(GENRES_CSV_AI_PROMPT.includes(token), `missing ${token}`);
  }
});
