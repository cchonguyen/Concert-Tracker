// The steps of a lineup lookup, from its stage and status. Pure, so the mapping the card shows can be tested.
import type { JobStage, JobStatus } from '../server/lineup/types';

export const LINEUP_STEPS = ['Find sources', 'Read pages', 'Search for more', 'Merge and cite', 'Your review'] as const;

// Where each stage sits in LINEUP_STEPS. "done" is the review step.
const STAGE_STEP: Record<JobStage, number> = { collect: 0, extract: 1, discover: 2, merge: 3, done: 4 };
const REVIEW = LINEUP_STEPS.length - 1;

export type LineupStepState = 'done' | 'active' | 'paused' | 'failed' | 'ready' | 'todo';
export interface LineupStep {
  label: string;
  state: LineupStepState;
}

export function lineupSteps(job: { status: JobStatus; stage: JobStage }): LineupStep[] {
  // Every step is done once the lineup is confirmed.
  if (job.status === 'confirmed') return LINEUP_STEPS.map((label) => ({ label, state: 'done' }));
  // A lookup that waits for you ends on the review step, which is ready for you to act on.
  const current = job.status === 'needs_review' ? REVIEW : STAGE_STEP[job.stage];
  return LINEUP_STEPS.map((label, i) => {
    if (i < current) return { label, state: 'done' };
    if (i > current) return { label, state: 'todo' };
    return { label, state: stateOf(job.status) };
  });
}

// The state of the step the lookup is on.
function stateOf(status: JobStatus): LineupStepState {
  if (status === 'needs_review') return 'ready';
  if (status === 'waiting_quota') return 'paused';
  if (status === 'failed' || status === 'no_data') return 'failed';
  return 'active';
}

// What a screen reader hears when the step changes: the step the lookup is on, or nothing when it has not started.
export function lineupAnnouncement(steps: LineupStep[]): string {
  const on = steps.find((s) => s.state !== 'done' && s.state !== 'todo');
  if (!on) return '';
  const word: Record<LineupStepState, string> = { done: '', active: 'running', paused: 'paused', failed: 'failed', ready: 'needs your review', todo: '' };
  return `${on.label}: ${word[on.state]}`;
}
