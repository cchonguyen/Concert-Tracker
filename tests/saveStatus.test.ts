import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agoLabel,
  beginSave,
  emptyTrack,
  failSave,
  hintVisit,
  saveLabel,
  succeedSave,
  takeFailed,
} from '../src/services/saveStatus.ts';

const MIN = 60_000;

test('a fresh track shows nothing', () => {
  assert.equal(saveLabel(emptyTrack<string>(), 0), '');
});

test('a save in flight says Saving, even after an earlier failure', () => {
  const t = beginSave(failSave(beginSave(emptyTrack<string>()), 'a'));
  assert.equal(saveLabel(t, 0), 'Saving…');
});

test('a finished save says Saved with its age, and ages', () => {
  const t = succeedSave(beginSave(emptyTrack<string>()), 1000);
  assert.equal(saveLabel(t, 1000), 'Saved · just now');
  assert.equal(saveLabel(t, 1000 + 2 * MIN), 'Saved · 2 min ago');
  assert.equal(saveLabel(t, 1000 + 90 * MIN), 'Saved · 1 h ago');
});

test('a failed save stays failed, keeps its patch, and is not cleared by an unrelated success', () => {
  const failed = failSave(beginSave(emptyTrack<string>()), 'venue');
  assert.equal(saveLabel(failed, 0), "Couldn't save · Try again");
  const later = succeedSave(beginSave(failed), 5);
  assert.equal(saveLabel(later, 5), "Couldn't save · Try again");
  assert.deepEqual(later.failed, ['venue']);
});

test('Try again takes the failed patches out and resends them; a success then clears the failure', () => {
  const failed = failSave(beginSave(emptyTrack<string>()), 'venue');
  const { track, patches } = takeFailed(failed);
  assert.deepEqual(patches, ['venue']);
  const retrying = beginSave(track);
  assert.equal(saveLabel(retrying, 0), 'Saving…');
  const done = succeedSave(retrying, 9);
  assert.equal(saveLabel(done, 9), 'Saved · just now');
  assert.deepEqual(done.failed, []);
});

test('a retry that fails again keeps the patch', () => {
  const { track, patches } = takeFailed(failSave(beginSave(emptyTrack<string>()), 'city'));
  const again = failSave(beginSave(track), patches[0]);
  assert.deepEqual(again.failed, ['city']);
  assert.equal(saveLabel(again, 0), "Couldn't save · Try again");
});

test('in-flight count stays at zero when every save has settled', () => {
  const t = failSave(succeedSave(beginSave(beginSave(emptyTrack<string>())), 1), 'x');
  assert.equal(t.inFlight, 0);
});

test('agoLabel covers just now, minutes and hours', () => {
  assert.equal(agoLabel(0), 'just now');
  assert.equal(agoLabel(59_999), 'just now');
  assert.equal(agoLabel(MIN), '1 min ago');
  assert.equal(agoLabel(59 * MIN), '59 min ago');
  assert.equal(agoLabel(60 * MIN), '1 h ago');
});

test('the hint shows on the first three opens and counts each one', () => {
  assert.deepEqual(hintVisit(null), { show: true, next: 1 });
  assert.deepEqual(hintVisit('1'), { show: true, next: 2 });
  assert.deepEqual(hintVisit('2'), { show: true, next: 3 });
  assert.deepEqual(hintVisit('3'), { show: false, next: 4 });
});

test('a garbled stored count is treated as zero', () => {
  assert.deepEqual(hintVisit('nope'), { show: true, next: 1 });
  assert.deepEqual(hintVisit('-4'), { show: true, next: 1 });
});
