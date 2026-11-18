import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finderReadout } from '../src/server/telemetry/finderReadout.ts';
import type { IngestTraceRow } from '../src/server/lineup/store/types.ts';

const NOW = new Date('2026-11-18T12:00:00Z');
const row = (over: Partial<IngestTraceRow> & { steps?: IngestTraceRow['steps'] }): IngestTraceRow => ({
  id: 't',
  trigger: 'research',
  eventId: null,
  editionId: null,
  jobId: null,
  steps: [],
  subrequests: null,
  aiCostMicros: null,
  createdAt: '2026-11-17T12:00:00Z',
  ...over,
});
const step = (finder: string, outcome: string, ms = 10, candidates = 0) => ({
  name: 'finder',
  at: 0,
  detail: { finder, outcome, ms, candidates },
});

test('finder readout: counts runs, hits, empty, failures and success rate per finder', () => {
  const rows = [
    row({ steps: [step('brave', 'ok', 100, 2), step('clashfinder', 'off')] }),
    row({ steps: [step('brave', 'empty', 300), step('clashfinder', 'ok', 50, 1)] }),
    row({ steps: [step('brave', 'failed', 500)] }),
  ];
  const out = finderReadout(rows, NOW);
  const brave = out.find((r) => r.finder === 'brave')!;
  assert.equal(brave.runs, 3);
  assert.equal(brave.hits, 1);
  assert.equal(brave.empty, 1);
  assert.equal(brave.failures, 1);
  assert.equal(brave.successRate, 0.333);
  assert.equal(brave.medianMs, 300);
  const cf = out.find((r) => r.finder === 'clashfinder')!;
  assert.equal(cf.runs, 1, 'a finder that was off in one run does not count that run');
  assert.equal(cf.successRate, 1);
});

test('finder readout: a retry inside one run counts once, as a hit when either call hit', () => {
  const out = finderReadout([row({ steps: [step('brave', 'empty', 10), step('brave', 'ok', 20, 1)] })], NOW);
  assert.equal(out[0].runs, 1);
  assert.equal(out[0].hits, 1);
});

test('finder readout: ignores other triggers and runs older than the window', () => {
  const out = finderReadout(
    [
      row({ trigger: 'save', steps: [step('brave', 'ok')] }),
      row({ createdAt: '2026-09-01T00:00:00Z', steps: [step('brave', 'ok')] }),
    ],
    NOW,
  );
  assert.deepEqual(out, []);
});

test('finder readout: a finder that never ran has no success rate, and no timing without calls', () => {
  const out = finderReadout([row({ steps: [step('setlistfm', 'off')] })], NOW);
  assert.deepEqual(out, []);
});
