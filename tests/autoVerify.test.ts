import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editionVerified,
  fillEmptyFields,
  nextActStatus,
  normalizeActName,
  verifyAct,
  type ActEvidence,
  type EditionField,
} from '../src/server/canon/autoVerify.ts';

const exp = { editionKey: 'ed-1', name: 'Above & Beyond', date: '2026-07-04' };
const ev = (over: Partial<ActEvidence> = {}): ActEvidence => ({
  sourceId: 'src-1',
  kind: 'fetched_page',
  trusted: false,
  editionKey: 'ed-1',
  name: 'Above & Beyond',
  date: '2026-07-04',
  ...over,
});

test('auto-verify: one trusted source verifies an act', () => {
  const v = verifyAct([ev({ kind: 'ticket_email', trusted: true })], exp);
  assert.deepEqual(v, { status: 'verified', verifiedBy: 'trusted_source', sourceCount: 1 });
});

test('auto-verify: two independent fetched sources verify an act', () => {
  const v = verifyAct([ev({ sourceId: 'a' }), ev({ sourceId: 'b', kind: 'api_record' })], exp);
  assert.equal(v.status, 'verified');
  assert.equal(v.verifiedBy, 'two_sources');
  assert.equal(v.sourceCount, 2);
});

test('auto-verify: one untrusted fetched source stays a candidate', () => {
  const v = verifyAct([ev()], exp);
  assert.equal(v.status, 'candidate');
  assert.equal(v.verifiedBy, 'none');
});

test('auto-verify: the same source twice counts once', () => {
  const v = verifyAct([ev({ sourceId: 'same' }), ev({ sourceId: 'same' })], exp);
  assert.equal(v.status, 'candidate');
  assert.equal(v.sourceCount, 1);
});

test('auto-verify: a member tick never verifies, even with another member tick', () => {
  const v = verifyAct(
    [ev({ kind: 'member_entry', sourceId: 'tick-1', trusted: true }), ev({ kind: 'member_entry', sourceId: 'tick-2' })],
    exp,
  );
  assert.equal(v.status, 'candidate');
  assert.equal(v.sourceCount, 0);
});

test('auto-verify: an external ID alone never verifies', () => {
  const v = verifyAct([ev({ kind: 'external_id', sourceId: 'setlistfm-1', trusted: true })], exp);
  assert.equal(v.status, 'candidate');
});

test('auto-verify: a different date or edition does not count', () => {
  const v = verifyAct(
    [ev({ sourceId: 'a', date: '2026-07-05' }), ev({ sourceId: 'b', editionKey: 'ed-2', trusted: true })],
    exp,
  );
  assert.equal(v.status, 'candidate');
  assert.equal(v.sourceCount, 0);
});

test('auto-verify: name matching ignores case, accents and punctuation', () => {
  assert.equal(normalizeActName('Beyoncé  Knowles!'), 'beyonce knowles');
  const v = verifyAct([ev({ kind: 'ticket_email', trusted: true, name: 'ABOVE   AND beyond' })], {
    ...exp,
    name: 'Above and Beyond',
  });
  assert.equal(v.status, 'verified');
});

test('auto-verify: a verified act is never demoted by a later disagreeing source', () => {
  const disagree = verifyAct([ev({ sourceId: 'x', date: '2026-08-01' })], exp);
  assert.equal(nextActStatus('verified', disagree), 'verified');
  assert.equal(nextActStatus('candidate', disagree), 'candidate');
});

test('auto-verify: an edition needs all five fields from verified sources', () => {
  const full = {
    name: { value: 'Ultra 2026', verified: true },
    act: { value: 'Above & Beyond', verified: true },
    location: { value: 'Miami', verified: true },
    venue: { value: 'Bayfront Park', verified: true },
    date: { value: '2026-03-27', verified: true },
  };
  assert.equal(editionVerified(full), true);
  assert.equal(editionVerified({ ...full, venue: { value: 'Bayfront Park', verified: false } }), false);
  assert.equal(editionVerified({ ...full, venue: undefined }), false);
  assert.equal(editionVerified({ ...full, location: { value: '  ', verified: true } }), false);
});

test('auto-verify: filling keeps owner-typed values and fills only empty fields', () => {
  const current: Partial<Record<EditionField, string>> = { name: 'Ultra Miami', venue: '' };
  const owner = new Set<EditionField>(['name']);
  const filled = fillEmptyFields(
    current,
    { name: 'Ultra 2026', venue: 'Bayfront Park', city: undefined, date: '2026-03-27' } as Partial<Record<EditionField, string>>,
    owner,
  );
  assert.deepEqual(filled, ['venue', 'date']);
  assert.equal(current.name, 'Ultra Miami');
  assert.equal(current.venue, 'Bayfront Park');
  assert.equal(current.date, '2026-03-27');
});

test('auto-verify: an incoming value never replaces a value already set', () => {
  const current: Partial<Record<EditionField, string>> = { venue: 'Bayfront Park' };
  const filled = fillEmptyFields(current, { venue: 'Other Park' }, new Set());
  assert.deepEqual(filled, []);
  assert.equal(current.venue, 'Bayfront Park');
});

test('a location from the venue fill counts as verified; other actors and none do not', async () => {
  const { locationVerifiedBy } = await import('../src/server/canon/autoVerify.ts');
  const { VENUE_FILL_ACTOR } = await import('../src/server/canon/venueFill.ts');
  assert.equal(locationVerifiedBy(VENUE_FILL_ACTOR), true);
  assert.equal(locationVerifiedBy('member:entry'), false);
  assert.equal(locationVerifiedBy(undefined), false);
});
