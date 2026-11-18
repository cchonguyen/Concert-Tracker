import assert from 'node:assert/strict';
import test from 'node:test';
import { lineupProposalPayload } from '../src/server/canon/nameArtists.ts';

test('a member proposal stores only the act, its name and the edition name', () => {
  const payload = lineupProposalPayload('Tsha at Sound Nightclub', { key: 'tsha', name: 'Tsha' });
  assert.deepEqual(Object.keys(payload).sort(), ['artistKey', 'artistName', 'editionName', 'quote']);
  assert.equal(payload.artistKey, 'tsha');
  assert.equal(payload.quote, 'Tsha at Sound Nightclub');
});

test('a proposal payload carries no user, email or personal field', () => {
  const payload: Record<string, unknown> = { ...lineupProposalPayload('Tsha', { key: 'tsha', name: 'Tsha' }) };
  for (const key of ['userId', 'user_id', 'email', 'member', 'notes', 'companions', 'rating', 'price', 'attended']) {
    assert.equal(key in payload, false, key);
  }
});
