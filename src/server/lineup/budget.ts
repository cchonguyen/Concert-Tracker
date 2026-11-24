import { AsyncLocalStorage } from 'node:async_hooks';

// Per-invocation subrequest budget. Every invocation (one HTTP request, one
// queue message, one cron run) gets its own budget. External fetches and
// Supabase calls take from it. When only the reserve is left, further calls
// are refused with BudgetExhausted, so the job's final save still has room.
// See ARCHITECTURE.md, "Subrequest budget".

const DEFAULT_LIMIT = 50;
const RESERVE = 4;

export class BudgetExhausted extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`Subrequest budget exhausted: ${used} of ${limit} used.`);
    this.name = 'BudgetExhausted';
  }
}

export interface Budget {
  limit: number;
  reserve: number;
  used: number;
  take(n?: number, opts?: { reserved?: boolean }): void;
}

export function makeBudget(): Budget {
  const raw = process.env.SUBREQUEST_LIMIT?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const limit = parsed > 0 ? parsed : DEFAULT_LIMIT;
  const budget: Budget = {
    limit,
    reserve: RESERVE,
    used: 0,
    take(n = 1, opts = {}) {
      // Ordinary calls stop at limit - reserve; reserved calls may use the reserve, never more than limit.
      const ceiling = opts.reserved ? budget.limit : budget.limit - budget.reserve;
      if (budget.used + n > ceiling) throw new BudgetExhausted(budget.used, budget.limit);
      budget.used += n;
    },
  };
  return budget;
}

const storage = new AsyncLocalStorage<Budget>();

export function runWithBudget<T>(budget: Budget, fn: () => Promise<T>): Promise<T> {
  return storage.run(budget, fn);
}

export function currentBudget(): Budget | undefined {
  return storage.getStore();
}

// Calls made inside fn may use the reserve: a write that must follow one already made
// (an edition's change record after the edition itself was saved).
const reserved = new AsyncLocalStorage<boolean>();

export function runReserved<T>(fn: () => Promise<T>): Promise<T> {
  return reserved.run(true, fn);
}

// The fetch Supabase uses (src/server/supabase.ts). Counts one call against the
// current budget, if there is one, then calls the global fetch.
export const countingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  currentBudget()?.take(1, { reserved: reserved.getStore() === true });
  return globalThis.fetch(input, init);
}) as typeof fetch;
