import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCsv } from '../src/services/listImport.ts';
import { parseArtistCleanupCsv } from '../src/server/entities/artistCleanupCsv.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Edition } from '../src/server/lineup/types.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

function makeEdition(id: string, performances: Edition['performances']): Edition {
  return {
    id,
    key: `${id}/2025`,
    year: 2025,
    name: `Event ${id}`,
    status: 'verified',
    performances,
    updatedAt: '2026-11-26T00:00:00.000Z',
  };
}

function makeEvent(id: string, seen: LoggedEvent['seen']): LoggedEvent {
  return {
    id,
    input: `My ${id}`,
    name: `My ${id}`,
    year: 2025,
    details: { status: 'resolved', candidates: [], notes: [] },
    daysAttended: [],
    companions: [],
    seen,
    sources: {},
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
  };
}

test('parseArtistCleanupCsv preserves \\xa0, validates headers, and sorts into 6-stage order', () => {
  const csv = [
    'Artist,MusicBrainz ID,Source,Version (leave as it is),Entity_Status,Invalid_Reason,Canonical_Artist,Canonical_Key,Set_Qualifier,Split_Artists,Split_Keys,Combo_Alias,Alter_Ego_Of,Alter_Ego_Of_Key,Cleanup_Notes',
    'TESTPILOT,,none,05f983e5,link_alter_ego,,,,,,,,Deadmau5,mbid:4a00ec9d-c635-463a-8cd4-eb61725f0c60,',
    'Manilla Killa,,owner,9a6c0948,rename,,Manila Killa,artist:Manilla Killa,,,,,,,typo',
    'Abana\u00a0B2B\u00a0D. Zeledon,,none,05f983e5,split_multi_artist,,,,,Abana; D. Zeledon,artist:Abana; artist:D. Zeledon,,,,b2b',
    '(Surprise),,none,05f983e5,invalid_non_artist,placeholder,,,,,,,,,placeholder',
  ].join('\r\n');

  const parsed = parseArtistCleanupCsv(parseCsv(csv));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 4);
  assert.deepEqual(
    parsed.rows.map((r) => r.status),
    ['invalid_non_artist', 'split_multi_artist', 'rename', 'link_alter_ego'],
  );
  const splitRow = parsed.rows[1];
  assert.equal(splitRow.artist, 'Abana\u00a0B2B\u00a0D. Zeledon');
  assert.equal(splitRow.splitItems.length, 2);
});

test('runArtistCleanup handles all 6 stages, pre-rename targets, genre preservation, B2B dedup, dry-run, and assertions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'artist-cleanup-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertArtist({ key: 'surprise', name: '(Surprise)' });
    await store.upsertArtist({ key: 'lost heroes', name: 'Lost Heroes' });
    await store.upsertArtist({ key: 'last heroes', name: 'LAST HEROES', mbid: 'b864449d-5017-4c9a-96bb-8e88e7d05dc8' });
    await store.upsertArtist({ key: 'porter robinson', name: 'Porter Robinson', mbid: '4ae36ade-1798-48c4-b06b-cc68b7d3d83f' });
    await store.upsertArtist({ key: 'porter robinson dj set', name: 'Porter Robinson (DJ Set)' });
    await store.upsertArtist({ key: 'worship sub focus b2b dimension b2b culture shock b2b 1991', name: 'Worship (Sub Focus B2B Dimension B2B Culture Shock B2B 1991)' });
    await store.upsertArtist({ key: 'worship', name: 'Worship' }); // Standalone artist matching Combo_Alias must survive!
    await store.upsertArtist({ key: 'sub focus', name: 'Sub Focus', mbid: '8cf49f40-b8fe-4a63-b4ea-f922d6145bb4' });
    await store.upsertArtist({ key: 'dimension', name: 'Dimension', mbid: '8314efe8-43e4-432e-a84d-f71450eb55ba' });
    await store.upsertArtist({ key: 'manilla killa', name: 'Manilla Killa' });
    await store.upsertArtist({ key: 'manilla killa b2b aobeats', name: 'Manilla Killa b2b AOBeats' });
    await store.upsertArtist({ key: 'aobeats', name: 'AOBeats', mbid: '665df0a8-51e4-49ad-9938-d4311bd573da' });
    await store.upsertArtist({ key: 'testpilot', name: 'TESTPILOT' });
    await store.upsertArtist({ key: 'deadmau5', name: 'Deadmau5', mbid: '4a00ec9d-c635-463a-8cd4-eb61725f0c60' });
    await store.upsertArtist({ key: 'alpha 9', name: 'Alpha 9', mbid: '73571b2f-1cc3-4b6b-b46c-6c48856e7c2f' });

    await store.upsertEdition(
      makeEdition('ed-1', [
        { artistKey: 'surprise', name: '(Surprise)', days: [], stages: [], status: 'billed', confidence: 1, sources: [] },
        { artistKey: 'lost heroes', name: 'Lost Heroes', days: ['2025-05-16'], stages: ['Main'], status: 'billed', confidence: 1, sources: [] },
        { artistKey: 'porter robinson dj set', name: 'Porter Robinson (DJ Set)', days: [], stages: [], status: 'billed', confidence: 1, sources: [] },
        { artistKey: 'worship sub focus b2b dimension b2b culture shock b2b 1991', name: 'Worship (Sub Focus B2B Dimension B2B Culture Shock B2B 1991)', days: [], stages: [], status: 'billed', confidence: 1, sources: [] },
        { artistKey: 'manilla killa b2b aobeats', name: 'Manilla Killa b2b AOBeats', days: [], stages: [], status: 'billed', confidence: 1, sources: [] },
      ]),
    );

    await store.putArtistGenres([
      { key: 'lost heroes', name: 'Lost Heroes', source: 'owner', genres: [{ style: 'Melodic Bass', parent: 'electronic', weight: 1 }], checkedAt: '2026-11-26T00:00:00.000Z' },
      { key: 'porter robinson dj set', name: 'Porter Robinson (DJ Set)', source: 'owner', genres: [{ style: 'Electro House', parent: 'electronic', weight: 1 }], checkedAt: '2026-11-26T00:00:00.000Z' },
    ]);

    await store.putEvent(
      makeEvent('ev-owner', [
        { key: 'surprise', name: '(Surprise)', from: 'you' },
        { key: 'porter robinson dj set', name: 'Porter Robinson (DJ Set)', from: 'you' },
        { key: 'manilla killa', name: 'Manilla Killa', from: 'you' },
      ]),
    );

    const csv = [
      'Artist,MusicBrainz ID,Source,Version (leave as it is),Entity_Status,Invalid_Reason,Canonical_Artist,Canonical_Key,Set_Qualifier,Split_Artists,Split_Keys,Combo_Alias,Alter_Ego_Of,Alter_Ego_Of_Key,Cleanup_Notes',
      '(Surprise),,none,05f983e5,invalid_non_artist,placeholder,,,,,,,,,generic_placeholder',
      'Lost Heroes,,owner,0f6d5770,merge_duplicate,,LAST HEROES,mbid:b864449d-5017-4c9a-96bb-8e88e7d05dc8,,,,,,,typo_duplicate_owner',
      'Porter Robinson (DJ Set),,owner,82bd1e46,remap_set,,Porter Robinson,mbid:4ae36ade-1798-48c4-b06b-cc68b7d3d83f,DJ Set,,,,,,strip_set_qualifier_owner_row',
      '"Worship (Sub Focus B2B Dimension B2B Culture Shock B2B 1991)",,none,05f983e5,split_multi_artist,,,,,Sub Focus; Dimension; Culture Shock; 1991,mbid:8cf49f40-b8fe-4a63-b4ea-f922d6145bb4; mbid:8314efe8-43e4-432e-a84d-f71450eb55ba; NEW; NEW,Worship,,,combo_alias_quartet',
      'Manilla Killa b2b AOBeats,,none,05f983e5,split_multi_artist,,,,,Manila Killa; AOBeats,artist:Manilla Killa; mbid:665df0a8-51e4-49ad-9938-d4311bd573da,,,,b2b',
      'Manilla Killa,,owner,9a6c0948,rename,,Manila Killa,artist:Manilla Killa,,,,,,,typo_fix_owner_row',
      'TESTPILOT,,none,05f983e5,link_alter_ego,,,,,,,,Deadmau5,mbid:4a00ec9d-c635-463a-8cd4-eb61725f0c60,',
      'Alpha 9,73571b2f-1cc3-4b6b-b46c-6c48856e7c2f,owner,10b49c94,link_alter_ego,,,,,,,,Arty,NEW,',
    ].join('\r\n');

    const { rows, errors } = parseArtistCleanupCsv(parseCsv(csv));
    assert.equal(errors.length, 0);

    // 1. Dry run leaves store untouched.
    const dry = await store.runArtistCleanup(rows, { dryRun: true, actor: 'system:artist-cleanup', reason: 'test' });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.failedResolutions.length, 0);
    assert.equal(dry.newArtistsInserted, 2); // Culture Shock, 1991
    assert.equal(dry.parentStubsInserted, 1); // Arty
    assert.ok(await store.getArtist('surprise'), 'dry-run must not delete');

    // 2. Apply commits atomically.
    const applied = await store.runArtistCleanup(rows, { dryRun: false, actor: 'system:artist-cleanup', reason: 'test' });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.failedResolutions.length, 0);
    assert.deepEqual(applied.assertions, { remainingDeprecatedActive: 0, orphanedPerformances: 0, missingBlocklistEntries: 0 });

    // Invalid removed & blocklisted with reason
    assert.equal(await store.getArtist('surprise'), null);
    const bl = await store.getBlocklist(['*']);
    assert.equal(bl.find((b) => b.normalized === 'surprise')?.reason, 'placeholder');

    // Merge duplicate copied owner genres to LAST HEROES
    const genres = await store.listArtistGenres();
    assert.equal(genres.find((g) => g.key === 'last heroes' && g.source === 'owner')?.genres[0]?.style, 'Melodic Bass');
    // Remap set did NOT copy set-specific genres onto Porter Robinson
    assert.equal(genres.find((g) => g.key === 'porter robinson'), undefined);

    // Standalone Worship artist preserved; split created Culture Shock & 1991
    assert.ok(await store.getArtist('worship'));
    assert.ok(await store.getArtist('culture shock'));
    assert.ok(await store.getArtist('1991'));

    // Pre-rename target Manila Killa resolved & renamed
    assert.equal(await store.getArtist('manilla killa'), null);
    assert.ok(await store.getArtist('manila killa'));

    // Alter egos linked + Arty stub created
    assert.equal((await store.getArtist('testpilot'))?.alterEgoOf, 'deadmau5');
    assert.equal((await store.getArtist('alpha 9'))?.alterEgoOf, 'arty');
    assert.ok(await store.getArtist('arty'));

    // Edition performances updated
    const ed = await store.getEdition('ed-1');
    assert.ok(ed);
    assert.equal(ed.performances.find((p) => p.artistKey === 'porter robinson')?.set, 'DJ Set');
    const subFocusPerf = ed.performances.find((p) => p.artistKey === 'sub focus');
    assert.equal(subFocusPerf?.alias, 'Worship');
    assert.equal(subFocusPerf?.b2b?.length, 3);
    assert.ok(ed.performances.some((p) => p.artistKey === 'manila killa'));

    // Owner event updated
    const ev = await store.getEvent('ev-owner');
    assert.ok(ev);
    assert.equal(ev.seen.some((s) => s.key === 'surprise'), false);
    assert.equal(ev.seen.find((s) => s.key === 'porter robinson')?.set, 'DJ Set');
    assert.ok(ev.seen.some((s) => s.key === 'manila killa' && s.name === 'Manila Killa'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runArtistCleanup resolves seen-only and genre-only universe artists (ALT1, Sam Gelliatry)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'artist-cleanup-univ-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertArtist({ key: 'sneijder pres alt 1', name: 'Sneijder pres Alt_1' });
    await store.upsertArtist({ key: 'sneijder', name: 'Sneijder', mbid: 'b1bd5cb7-4a61-4363-89ba-8a5c41c101d8' });

    // ALT1 and Sam Gelliatry exist only in seen_act_names / artist_genres (no canonical_artists row).
    await store.putEvent(
      makeEvent('ev-1', [
        { key: 'alt1', name: 'ALT1', from: 'you' },
        { key: 'sam gelliatry', name: 'Sam Gelliatry', from: 'you' },
      ]),
    );
    await store.putArtistGenres([
      {
        key: 'sam gelliatry',
        name: 'Sam Gelliatry',
        source: 'owner',
        genres: [{ style: 'Future Bass', parent: 'electronic', weight: 1 }],
        checkedAt: '2026-11-26T00:00:00.000Z',
      },
    ]);

    const csv = [
      'Artist,MusicBrainz ID,Source,Version (leave as it is),Entity_Status,Invalid_Reason,Canonical_Artist,Canonical_Key,Set_Qualifier,Split_Artists,Split_Keys,Combo_Alias,Alter_Ego_Of,Alter_Ego_Of_Key,Cleanup_Notes',
      'Sneijder pres Alt_1,,none,05f983e5,merge_duplicate,,ALT1,artist:ALT1,,,,,,,presents_alter_ego_dup',
      'Sam Gelliatry,,owner,245d1f57,rename,,Sam Gellaitry,artist:Sam Gelliatry,,,,,,,typo_fix_owner_row',
      'ALT1,,none,05f983e5,link_alter_ego,,,,,,,,Sneijder,mbid:b1bd5cb7-4a61-4363-89ba-8a5c41c101d8,',
    ].join('\r\n');

    const { rows, errors } = parseArtistCleanupCsv(parseCsv(csv));
    assert.equal(errors.length, 0);

    const applied = await store.runArtistCleanup(rows, { dryRun: false, actor: 'system:artist-cleanup', reason: 'test' });
    assert.equal(applied.failedResolutions.length, 0);

    assert.equal((await store.getArtist('alt1'))?.alterEgoOf, 'sneijder');
    const genres = await store.listArtistGenres();
    assert.equal(genres.find((g) => g.key === 'sam gellaitry' && g.source === 'owner')?.genres[0]?.style, 'Future Bass');
    assert.equal(genres.find((g) => g.key === 'sam gelliatry'), undefined);

    const ev = await store.getEvent('ev-1');
    assert.ok(ev?.seen.some((s) => s.key === 'sam gellaitry' && s.name === 'Sam Gellaitry'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
