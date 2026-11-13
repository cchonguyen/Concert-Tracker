import { pacificDay, nextPacificMidnight, QuotaExhaustedError, type QuotaLedger, type AcquireOptions } from '../lineup/quota';
import type { LineupStore } from '../lineup/store/types';
import type { ReaderConfig } from './config';
import { estimateCostUsd, worstCaseMicroUsd } from './pricing';
import type { ReaderOutcome, ReaderProvider, ReaderUsage } from './types';

export const BREAKER_KEY = 'reader:breaker';
const UNAVAILABLE_RETRY_MS = 5 * 60_000;

export function zeroUsage(provider: ReaderProvider, model: string): ReaderUsage {
  return { provider, model, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

export function dayKey(now: Date): string {
  return `reader:spend:day:${pacificDay(now)}`;
}
export function monthKey(now: Date): string {
  return `reader:spend:month:${now.toISOString().slice(0, 7)}`;
}
export function callsMonthKey(now: Date): string {
  return `reader:calls:month:${now.toISOString().slice(0, 7)}`;
}
export function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface GuardArgs {
  store: LineupStore;
  config: ReaderConfig;
  provider: ReaderProvider;
  model: string;
  inputChars: number; // the text actually sent (after lineupWindow)
  maxOutputTokens: number;
  jobKey: string; // `<jobId>` or `details:<eventId>:<YYYY-MM-DD>`
  quota?: QuotaLedger; // guard 9 (existing provider:model:day ledger); skipped when absent
  quotaOptions?: AcquireOptions;
  now?: Date;
  force?: boolean; // only bypasses a pause set by an earlier 429 (inside guard 9); never guards 1 to 8
}

export type GuardResult =
  | { ok: true; worstCaseMicroUsd: number }
  | { ok: false; reason: 'input_too_large'; usage: ReaderUsage };

async function ledger<T>(now: Date, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof QuotaExhaustedError) throw err;
    throw new QuotaExhaustedError(new Date(now.getTime() + UNAVAILABLE_RETRY_MS), 'guard_unavailable');
  }
}

async function openBreaker(store: LineupStore, until: Date, now: Date): Promise<void> {
  const cur = (await store.getQuota(BREAKER_KEY)) ?? { key: BREAKER_KEY, used: 0 };
  await store.setQuota({ ...cur, exhaustedUntil: until.toISOString() });
}

// Opens the breaker, then throws the refusal. A failure to open still refuses (fail closed).
async function refuseAndOpen(args: GuardArgs, now: Date, until: Date, reason: string): Promise<never> {
  try {
    await openBreaker(args.store, until, now);
  } catch {
    // still refuse
  }
  throw new QuotaExhaustedError(until, reason);
}

export async function checkGuards(args: GuardArgs): Promise<GuardResult> {
  const { store, config, provider, model } = args;
  const now = args.now ?? new Date();
  const cooldownUntil = new Date(now.getTime() + config.breakerCooldownMin * 60_000);

  // 1 kill switch
  if (!config.enabled) throw new QuotaExhaustedError(cooldownUntil, 'kill_switch');

  // 2 breaker open
  const breaker = await ledger(now, () => store.getQuota(BREAKER_KEY));
  if (breaker?.exhaustedUntil && new Date(breaker.exhaustedUntil) > now) {
    throw new QuotaExhaustedError(new Date(breaker.exhaustedUntil), 'breaker_open');
  }

  // 3 unpinned model (only when the provider was chosen explicitly)
  if (config.providerExplicit && /-latest\b/i.test(model)) {
    throw new QuotaExhaustedError(cooldownUntil, 'unpinned_model');
  }

  // 5 input size: a returned result, never a throw, breaker untouched
  if (args.inputChars > config.maxInputChars) {
    return { ok: false, reason: 'input_too_large', usage: zeroUsage(provider, model) };
  }

  // 6 calls per job: parks only this job
  const jobKey = `reader:job:${args.jobKey}`;
  const job = await ledger(now, async () => (await store.getQuota(jobKey)) ?? { key: jobKey, used: 0 });
  if (job.used >= config.maxCallsPerJob) {
    throw new QuotaExhaustedError(nextPacificMidnight(now), 'job_cap', 'job');
  }

  // 7 and 8 spend caps, in memory only
  const { micro } = worstCaseMicroUsd(provider, model, args.inputChars, args.maxOutputTokens);
  const day = await ledger(now, async () => (await store.getQuota(dayKey(now)))?.used ?? 0);
  if (day + micro > config.maxSpendDayUsd * 1_000_000) {
    return refuseAndOpen(args, now, nextPacificMidnight(now), 'spend_day');
  }
  const month = await ledger(now, async () => (await store.getQuota(monthKey(now)))?.used ?? 0);
  if (month + micro > config.maxSpendMonthUsd * 1_000_000) {
    return refuseAndOpen(args, now, nextUtcMonthStart(now), 'spend_month');
  }

  // 9 calls per minute and per day (last, so counters only advance for calls that will be made)
  if (args.quota) {
    try {
      await args.quota.acquire(now, { ...args.quotaOptions, ignorePause: args.force ?? args.quotaOptions?.ignorePause });
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        if (err.scope === 'user') throw err; // one member's cap never opens the global breaker
        return refuseAndOpen(args, now, err.retryAt, 'calls_cap');
      }
      throw new QuotaExhaustedError(new Date(now.getTime() + UNAVAILABLE_RETRY_MS), 'guard_unavailable');
    }
  }

  // The job counter advances only for a call that will be made.
  await ledger(now, () => store.setQuota({ ...job, used: job.used + 1 }));
  return { ok: true, worstCaseMicroUsd: micro };
}

export interface OutcomeArgs {
  store: LineupStore;
  config: ReaderConfig;
  provider: ReaderProvider;
  model: string;
  outcome: ReaderOutcome;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  worstCaseMicroUsd: number;
  retryAt?: Date; // for 'quota': when the provider said to come back
  now?: Date;
}

// Real cost in micro-dollars: reported usage, else the worst case for a success, else 0.
export function realCostMicroUsd(a: Pick<OutcomeArgs, 'provider' | 'model' | 'outcome' | 'usage' | 'worstCaseMicroUsd'>): number {
  const usd = a.usage ? estimateCostUsd(a.provider, a.model, a.usage) : null;
  if (usd !== null) return Math.ceil(usd * 1_000_000);
  return a.outcome === 'success' ? a.worstCaseMicroUsd : 0;
}

// Post-call: one write per spend key (day, month) adding the cost, and a breaker update.
// Throws QuotaExhaustedError('guard_unavailable') if the ledger cannot be written.
export async function recordOutcome(args: OutcomeArgs): Promise<void> {
  const { store, config } = args;
  const now = args.now ?? new Date();
  const cost = realCostMicroUsd(args);
  await ledger(now, async () => {
    // Owner view: calls made this UTC month (every provider call, whatever its outcome).
    const calls = (await store.getQuota(callsMonthKey(now))) ?? { key: callsMonthKey(now), used: 0 };
    await store.setQuota({ ...calls, used: calls.used + 1 });
    if (cost > 0) {
      for (const key of [dayKey(now), monthKey(now)]) {
        const cur = (await store.getQuota(key)) ?? { key, used: 0 };
        await store.setQuota({ ...cur, used: cur.used + cost });
      }
    }
    const b = (await store.getQuota(BREAKER_KEY)) ?? { key: BREAKER_KEY, used: 0 };
    if (args.outcome === 'success') {
      if (b.used !== 0) await store.setQuota({ ...b, used: 0 });
      return;
    }
    if (args.outcome === 'quota') {
      const until = args.retryAt ?? new Date(now.getTime() + config.breakerCooldownMin * 60_000);
      await store.setQuota({ ...b, exhaustedUntil: until.toISOString() });
      return;
    }
    const count = b.used + 1;
    const next = { ...b, used: count };
    if (count >= config.breakerFailures) {
      next.exhaustedUntil = new Date(now.getTime() + config.breakerCooldownMin * 60_000).toISOString();
    }
    await store.setQuota(next);
  });
}
