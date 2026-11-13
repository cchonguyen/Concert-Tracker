import { randomUUID } from 'node:crypto';
import type { IngestTraceRow, IngestTraceTrigger } from '../lineup/store/types';

// Ingest trace collector (slice 11.20; docs/ingest-canon-plan.md, "Review queue and traces").
// Steps collect in memory and are written in ONE insert at the end of a message. Counts, status words,
// source names and ids only: never page text, quotes, prompts, or personal fields (AGENTS.md).

export type TraceDetail = Record<string, string | number | boolean | null>;
type TraceStore = { addIngestTrace(row: IngestTraceRow): Promise<void> };

const MAX_STRING = 200;
const MAX_KEYS = 12;
const MAX_STEPS = 100;
// Keys that could carry personal fields or page text; dropped whatever their value.
const BLOCKED_KEY = /companion|note|rating|price|attendance|text|body|quote|prompt|content|html|snippet|email|comment/i;

export function scrubDetail(detail: Record<string, unknown> | undefined): TraceDetail | undefined {
  if (!detail) return undefined;
  const out: TraceDetail = {};
  let n = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (n >= MAX_KEYS) break;
    if (BLOCKED_KEY.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value as number | boolean | null;
    } else if (typeof value === 'string') {
      out[key] = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    } else continue; // objects, arrays, functions: not small primitives
    n++;
  }
  return Object.keys(out).length ? out : undefined;
}

// If the table is missing (0043 not applied) or the database is down, stop trying for a few minutes.
const RETRY_AFTER_MS = 5 * 60_000;
let failedUntil = 0;
export function resetTraceFailureMemory(): void {
  failedUntil = 0;
}

export interface Trace {
  step(name: string, detail?: Record<string, unknown>): void;
  subrequests(n: number): void;
  cost(micros: number): void;
  // One store insert. Never throws, never fails the work.
  finish(store: TraceStore | null | undefined): Promise<void>;
}

export function startTrace(
  trigger: IngestTraceTrigger,
  ids: { eventId?: string | null; editionId?: string | null; jobId?: string | null } = {},
): Trace {
  const started = Date.now();
  const steps: IngestTraceRow['steps'] = [];
  let subs: number | null = null;
  let cost: number | null = null;
  let done = false;
  return {
    step(name, detail) {
      try {
        if (steps.length >= MAX_STEPS) return;
        const d = scrubDetail(detail);
        steps.push({ name: String(name).slice(0, 80), at: Date.now() - started, ...(d ? { detail: d } : {}) });
      } catch {
        // a trace never breaks the work
      }
    },
    subrequests(n) {
      if (Number.isFinite(n)) subs = Math.max(0, Math.round(n));
    },
    cost(micros) {
      if (Number.isFinite(micros)) cost = Math.max(0, Math.round(micros));
    },
    async finish(store) {
      try {
        if (done || !store || typeof store.addIngestTrace !== 'function') return;
        done = true;
        if (Date.now() < failedUntil) return;
        await store.addIngestTrace({
          id: randomUUID(),
          trigger,
          eventId: ids.eventId ?? null,
          editionId: ids.editionId ?? null,
          jobId: ids.jobId ?? null,
          steps,
          subrequests: subs,
          aiCostMicros: cost,
          createdAt: new Date().toISOString(),
        });
      } catch {
        failedUntil = Date.now() + RETRY_AFTER_MS;
      }
    },
  };
}
