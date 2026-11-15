import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billLines, gapQuestion, needsWeekendPrompt, thingsLeft } from '../src/services/poster.ts';
import type { LoggedEvent, SeenAct } from '../src/server/events/types.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const act = (key: string, role?: 'headliner' | 'support'): SeenAct => ({ key, name: key, from: 'you', role });
const keys = (acts: SeenAct[]) => acts.map((a) => a.key);

test('the large line is the headliners you saw, whatever order they are in', () => {
  const bill = billLines([act('support-a', 'support'), act('head-a', 'headliner'), act('plain')]);
  assert.deepEqual(keys(bill.large), ['head-a']);
  assert.deepEqual(keys(bill.medium), ['support-a', 'plain']);
});

test('with no headliner, the large line is the seen acts with no role', () => {
  const bill = billLines([act('support-a', 'support'), act('plain-a'), act('plain-b')]);
  assert.deepEqual(keys(bill.large), ['plain-a', 'plain-b']);
  assert.deepEqual(keys(bill.medium), ['support-a']);
});

test('a support act is never sized as the large line, even when listed first', () => {
  const bill = billLines([act('support-a', 'support')]);
  assert.deepEqual(keys(bill.large), []);
  assert.deepEqual(keys(bill.medium), ['support-a']);
});

test('no acts means nothing to draw', () => {
  assert.deepEqual(billLines([]), { large: [], medium: [], more: 0 });
});

test('cited lineup acts you did not see are counted as "more", each once', () => {
  const bill = billLines([act('head-a', 'headliner')], ['head-a', 'other-b', 'other-b', 'other-c']);
  assert.equal(bill.more, 2);
  assert.deepEqual(keys(bill.large), ['head-a']);
});

test('things left lists who you saw and the days first, then the rest in table order', () => {
  const gaps = new Set(['weather', 'venue', 'seen', 'date']);
  const left = thingsLeft({}, (_e, g) => gaps.has(g));
  assert.deepEqual(left, ['seen', 'date', 'venue', 'weather']);
});

test('nothing left is an empty list, so the strip can say all is filled in', () => {
  assert.deepEqual(thingsLeft({}, () => false), []);
});

test('needsWeekendPrompt is true only for linked multi-weekend events missing weekend and startDate', () => {
  const multiEdition = {
    weekends: [
      { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
      { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
    ],
  } as Pick<Edition, 'weekends'>;

  assert.equal(needsWeekendPrompt({ editionId: 'ed-1' }, multiEdition), true);
  assert.equal(needsWeekendPrompt({ editionId: 'ed-1', weekend: 2 }, multiEdition), false);
  assert.equal(needsWeekendPrompt({ editionId: 'ed-1', startDate: '2026-04-10' }, multiEdition), false);
  assert.equal(needsWeekendPrompt({ editionId: 'ed-1' }, { weekends: [{ weekend: 1, startDate: '2026-04-10' }] }), false);
  assert.equal(needsWeekendPrompt({ editionId: 'ed-1' }, null), false);
  assert.equal(needsWeekendPrompt({}, multiEdition), false);
});

test('gapQuestion switches date prompt to Which weekend? when needsWeekend is set', () => {
  assert.equal(gapQuestion('date'), 'When was it?');
  assert.equal(gapQuestion('date', { needsWeekend: true }), 'Which weekend?');
  assert.equal(gapQuestion('seen', { needsWeekend: true }), 'Who did you see?');
});
