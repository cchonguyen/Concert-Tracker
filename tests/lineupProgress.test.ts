import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineupAnnouncement, lineupSteps, LINEUP_STEPS, type LineupStep, type LineupStepState } from '../src/services/lineupProgress.ts';
import type { JobStage, JobStatus } from '../src/server/lineup/types.ts';

const states = (status: JobStatus, stage: JobStage): LineupStepState[] => lineupSteps({ status, stage }).map((s) => s.state);

test('the steps are the five the spec names, in order', () => {
  assert.deepEqual([...LINEUP_STEPS], ['Find sources', 'Read pages', 'Search for more', 'Merge and cite', 'Your review']);
});

test('a running lookup is active on its stage, done before it, not started after', () => {
  assert.deepEqual(states('running', 'collect'), ['active', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('running', 'extract'), ['done', 'active', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('running', 'merge'), ['done', 'done', 'done', 'active', 'todo']);
});

test('a queued lookup between steps still shows as active', () => {
  assert.deepEqual(states('queued', 'discover'), ['done', 'done', 'active', 'todo', 'todo']);
});

test('a lookup waiting for quota pauses on its step, and keeps the steps before it', () => {
  assert.deepEqual(states('waiting_quota', 'discover'), ['done', 'done', 'paused', 'todo', 'todo']);
});

test('a failed or empty lookup marks its step failed', () => {
  assert.deepEqual(states('failed', 'merge'), ['done', 'done', 'done', 'failed', 'todo']);
  assert.deepEqual(states('no_data', 'collect'), ['failed', 'todo', 'todo', 'todo', 'todo']);
});

test('a lookup that needs review is done up to the review step, which is ready', () => {
  assert.deepEqual(states('needs_review', 'done'), ['done', 'done', 'done', 'done', 'ready']);
});

test('a confirmed lookup has every step done', () => {
  assert.deepEqual(states('confirmed', 'done'), ['done', 'done', 'done', 'done', 'done']);
});

test('the announcement names the step the lookup is on, in words', () => {
  assert.equal(lineupAnnouncement(lineupSteps({ status: 'running', stage: 'extract' })), 'Read pages: running');
  assert.equal(lineupAnnouncement(lineupSteps({ status: 'waiting_quota', stage: 'discover' })), 'Search for more: paused');
  assert.equal(lineupAnnouncement(lineupSteps({ status: 'needs_review', stage: 'done' })), 'Your review: needs your review');
  assert.equal(lineupAnnouncement(lineupSteps({ status: 'confirmed', stage: 'done' })), '');
});

test('an announcement is empty when no step is on', () => {
  const none: LineupStep[] = LINEUP_STEPS.map((label) => ({ label, state: 'todo' }));
  assert.equal(lineupAnnouncement(none), '');
});
