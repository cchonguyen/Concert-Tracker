import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUndo, describeEntry, isSensitiveField, type ActivityEntry } from '../src/server/events/activityLog.ts';

const base: ActivityEntry = {
  id: 'a1',
  eventId: 'e1',
  action: 'update',
  field: 'venue',
  before: 'Old Hall',
  after: 'New Hall',
  sensitive: false,
  at: '2026-10-29T10:00:00Z',
};

test('undo writes back when the field still holds the logged value', () => {
  assert.deepEqual(checkUndo(base, 'New Hall', false), { ok: true });
});

test('undo is refused when the field changed after the logged write', () => {
  assert.deepEqual(checkUndo(base, 'Someone else changed it', false), { ok: false, reason: 'value-changed' });
});

test('undo of a sensitive field is refused while the vault is locked', () => {
  const notes: ActivityEntry = { ...base, field: 'notes', sensitive: true, after: 'ciphertext-2' };
  assert.deepEqual(checkUndo(notes, 'ciphertext-2', true), { ok: false, reason: 'vault-locked' });
});

test('undo of a sensitive field works once the vault is unlocked', () => {
  const notes: ActivityEntry = { ...base, field: 'notes', sensitive: true, after: 'ciphertext-2' };
  assert.deepEqual(checkUndo(notes, 'ciphertext-2', false), { ok: true });
});

test('a missing value is compared as null', () => {
  const cleared: ActivityEntry = { ...base, after: null };
  assert.deepEqual(checkUndo(cleared, undefined, false), { ok: true });
});

test('sensitive rows describe the change without its text', () => {
  const notes: ActivityEntry = { ...base, field: 'notes', sensitive: true, before: 'secret diary', after: 'secret diary 2' };
  const line = describeEntry(notes, 'Blur at Roundhouse');
  assert.equal(line, 'You updated the notes of Blur at Roundhouse');
  assert.ok(!line.includes('secret'));
});

test('companions are described without names', () => {
  const companions: ActivityEntry = { ...base, field: 'companions', sensitive: true, after: 'ciphertext' };
  assert.equal(describeEntry(companions, 'Blur'), 'You updated who you went with at Blur');
});

test('ordinary field changes name the field', () => {
  assert.equal(describeEntry(base, 'Blur'), 'You changed venue of Blur');
});

test('delete and restore have their own wording', () => {
  assert.equal(describeEntry({ ...base, action: 'delete', field: null }, 'Blur'), 'You deleted Blur');
  assert.equal(describeEntry({ ...base, action: 'restore', field: null }, 'Blur'), 'You restored Blur');
});

test('only notes and companions count as sensitive fields', () => {
  assert.equal(isSensitiveField('notes'), true);
  assert.equal(isSensitiveField('companions'), true);
  assert.equal(isSensitiveField('venue'), false);
});
