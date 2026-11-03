import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { confirmCanonicalEdition, CanonicalInputError, parseCanonicalInput } from '../src/server/lineup/canonicalIngest.ts';

const store = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'canon-confirm-')));
const base = {
  name: 'Portola Music Festival',
  year: 2024,
  startDate: '2024-09-28',
  venue: 'Pier 80',
  city: 'San Francisco, CA',
  performers: [
    { name: 'Rüfüs Du Sol', billing: 'headliner', days: ['2024-09-28'], stages: ['Pier Stage'], set: 'DJ Set' },
    { name: 'Lane 8' },
  ],
};

test('preview writes nothing; apply writes the confirmed edition', async () => {
  const s = await store();
  const preview = await confirmCanonicalEdition(s, parseCanonicalInput(base));
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.diff.added, ['Rüfüs Du Sol', 'Lane 8']);
  assert.equal(await s.getEditionByKey('portola-music-festival/2024-09-28'), null);

  const done = await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  assert.equal(done.applied, true);
  const saved = await s.getEditionByKey('portola-music-festival/2024-09-28');
  assert.equal(saved?.status, 'confirmed');
  assert.equal(saved?.performances.length, 2);
  assert.equal(saved?.performances.find((p) => p.name === 'Rüfüs Du Sol')?.billing, 'headliner');
});

test('an act with no billing stays without a role; the owner source is recorded', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const e = await s.getEditionByKey('portola-music-festival/2024-09-28');
  const lane = e!.performances.find((p) => p.name === 'Lane 8')!;
  assert.equal(lane.billing, undefined);
  assert.equal(lane.sources[0].extractor, 'admin_curation');
  assert.equal(lane.sources[0].sourceUrl, '');
});

test('re-confirming merges: unchanged acts are reported, blank facts filled, conflicts not overwritten', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const again = await confirmCanonicalEdition(
    s,
    parseCanonicalInput({
      ...base,
      venue: 'Different Venue',
      endDate: '2024-09-29',
      performers: [{ name: 'Rüfüs Du Sol', billing: 'headliner', days: ['2024-09-28'], stages: ['Pier Stage'], set: 'DJ Set' }, { name: 'Odesza' }],
      apply: false,
    }),
  );
  assert.deepEqual(again.diff.unchanged, ['Rüfüs Du Sol']);
  assert.deepEqual(again.diff.added, ['Odesza']);
  assert.deepEqual(again.diff.filledFacts, ['endDate']);
  assert.deepEqual(again.diff.factConflicts, [{ field: 'venue', stored: 'Pier 80', sent: 'Different Venue' }]);
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, endDate: '2024-09-29', venue: 'Different Venue', performers: [{ name: 'Odesza' }], apply: true }));
  const e = await s.getEditionByKey('portola-music-festival/2024-09-28');
  assert.equal(e?.venue, 'Pier 80');
  assert.equal(e?.endDate, '2024-09-29');
  assert.equal(e?.performances.length, 3, 'stored acts are kept when the request does not name them');
});

test('accepted:false ignores an act and never removes one', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, performers: [{ name: 'Lane 8', accepted: false }], apply: true }));
  const e = await s.getEditionByKey('portola-music-festival/2024-09-28');
  assert.equal(e?.performances.length, 2);
});

test('invalid input is refused with a clear message, not defaulted', () => {
  assert.throws(() => parseCanonicalInput({ ...base, year: 'twenty' }), CanonicalInputError);
  assert.throws(() => parseCanonicalInput({ ...base, startDate: '28/09/2024' }), CanonicalInputError);
  assert.throws(() => parseCanonicalInput({ ...base, performers: [{ name: 'X', billing: 'opener' }] }), CanonicalInputError);
  assert.throws(() => parseCanonicalInput({ ...base, name: '' }), CanonicalInputError);
});

test('confirm never writes to a personal log (Invariant 7)', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  assert.deepEqual(await s.listEvents(), []);
});
