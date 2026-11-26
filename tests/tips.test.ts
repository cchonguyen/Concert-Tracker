import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTips, FOLD_AFTER, isShown, markFolded, needsNudge, NO_TIPS, readTips, recordVisit, saveTips, setShowAll } from '../src/services/tips.ts';

const visit = (n: number, key = 'table') => {
  let s = NO_TIPS;
  for (let i = 0; i < n; i++) s = recordVisit(s, key);
  return s;
};

test('a tip shows on its first 3 visits and folds away on the 4th', () => {
  assert.equal(FOLD_AFTER, 3);
  assert.equal(isShown(NO_TIPS, 'table'), true);
  assert.equal(isShown(visit(3), 'table'), true);
  assert.equal(isShown(visit(4), 'table'), false);
  assert.equal(isShown(visit(4), 'manage'), true, 'each tip counts its own visits');
});

test('visits stop counting once the tip has folded, so nothing more is saved', () => {
  const s = visit(4);
  assert.equal(recordVisit(s, 'table'), s);
  assert.equal(s.visits.table, FOLD_AFTER + 1);
});

test('the ? or the × wins over the visit rule', () => {
  assert.equal(isShown(chooseTips(visit(9), ['table'], true), 'table'), true);
  assert.equal(isShown(chooseTips(NO_TIPS, ['table'], false), 'table'), false);
  const both = chooseTips(NO_TIPS, ['manage', 'archive-changes'], false);
  assert.equal(isShown(both, 'manage'), false);
  assert.equal(isShown(both, 'archive-changes'), false);
  assert.equal(isShown(both, 'table'), true);
});

test('the nudge comes once, only when the visit rule folds a tip', () => {
  const folded = visit(4);
  assert.equal(needsNudge(NO_TIPS, 'table'), false, 'a showing tip needs no nudge');
  assert.equal(needsNudge(folded, 'table'), true);
  assert.equal(needsNudge(markFolded(folded, ['table']), 'table'), false);
  assert.equal(needsNudge(chooseTips(NO_TIPS, ['table'], false), 'table'), false, 'hiding it yourself needs no nudge');
});

test('Show all tips shows every tip, clears earlier hides, and still lets you hide one', () => {
  const hidden = chooseTips(visit(9), ['manage'], false);
  const all = setShowAll(hidden, true);
  assert.equal(isShown(all, 'table'), true);
  assert.equal(isShown(all, 'manage'), true);
  const oneOff = chooseTips(all, ['table'], false);
  assert.equal(isShown(oneOff, 'table'), false);
  assert.equal(isShown(oneOff, 'manage'), true);
});

test('switching Show all tips off goes back to the visit rule without a nudge', () => {
  const off = setShowAll(setShowAll(chooseTips(visit(9), ['manage'], true), true), false);
  assert.equal(off.showAll, false);
  assert.deepEqual(off.choice, {});
  assert.equal(isShown(off, 'table'), false);
  assert.equal(isShown(off, 'manage'), true, 'manage has had no visits yet');
  assert.equal(needsNudge(off, 'table'), false);
});

test('the account copy round-trips, and an older Home choice still counts', () => {
  const s = chooseTips(setShowAll(visit(2), true), ['manage'], false);
  assert.deepEqual(readTips(saveTips(s)), s);
  assert.deepEqual(readTips(null), NO_TIPS);
  assert.equal(isShown(readTips({ dismissed: ['fill'], allHidden: true }), 'home'), false);
  assert.equal(isShown(readTips({ dismissed: ['fill'], allHidden: false }), 'home'), true);
});
