import { LineupStore } from './store/types';

// Thrown when a provider has no capacity. The job is parked until retryAt;
// nothing downstream may substitute a guess.
export class QuotaExhaustedError extends Error {
  constructor(
    public readonly retryAt: Date,
    public readonly reason: string,
    // 'user': one member's own cap, which must not pause everyone else.
    public readonly scope: 'global' | 'user' = 'global',
  ) {
    super(reason);
  }
}

const PT = 'America/Los_Angeles';

function ptParts(at: Date): { day: string; hour: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function pacificDay(at: Date): string {
  return ptParts(at).day;
}

// Gemini daily quotas reset at midnight Pacific time.
export function nextPacificMidnight(at: Date): Date {
  const today = new Date(`${pacificDay(at)}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() + 1);
  const nextDay = today.toISOString().slice(0, 10);
  for (const offset of ['-07:00', '-08:00']) {
    const candidate = new Date(`${nextDay}T00:00:00${offset}`);
    const p = ptParts(candidate);
    if (p.day === nextDay && p.hour === 0) return candidate;
  }
  return new Date(`${nextDay}T08:00:00Z`);
}

// Reads a Gemini 429 and decides how long to wait.
export function parseRateLimitError(err: unknown, now: Date): QuotaExhaustedError | null {
  const e = err as { status?: number; code?: number; message?: string };
  const message = typeof e?.message === 'string' ? e.message : String(err ?? '');
  const is429 = e?.status === 429 || e?.code === 429 || /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(message);
  if (!is429) return null;
  if (/PerDay/i.test(message)) {
    return new QuotaExhaustedError(nextPacificMidnight(now), 'Gemini daily limit reached; retrying after the midnight Pacific reset.');
  }
  const delay = message.match(/retryDelay\W+(\d+(?:\.\d+)?)s/);
  const seconds = delay ? Math.ceil(Number(delay[1])) : 60;
  return new QuotaExhaustedError(new Date(now.getTime() + (seconds + 1) * 1000), `Gemini rate limit hit; retrying in ${seconds}s.`);
}

export interface QuotaConfig {
  provider: string;
  model: string;
  dailyLimit: number;
  perMinute: number;
  // Multi-user: calls kept back for the owner (members share dailyLimit minus
  // this) and the most any one member may use a day. 0 means no limit.
  ownerReserve?: number;
  userDaily?: number;
}

export interface AcquireOptions {
  ignorePause?: boolean;
  // The member the call is for; left out in single-owner mode.
  userId?: string;
}

// Self-tracked budget so the app stops before Google says no, and so a parked
// job knows when to wake up.
export class QuotaLedger {
  private recent: number[] = [];

  constructor(
    private readonly store: LineupStore,
    private readonly config: QuotaConfig,
  ) {}

  private key(now: Date): string {
    return `${this.config.provider}:${this.config.model}:${pacificDay(now)}`;
  }

  async status(now = new Date()): Promise<{ used: number; limit: number; exhaustedUntil?: string }> {
    const usage = await this.store.getQuota(this.key(now));
    return { used: usage?.used ?? 0, limit: this.config.dailyLimit, exhaustedUntil: usage?.exhaustedUntil };
  }

  // Throws QuotaExhaustedError when the call must not be made now.
  // ignorePause: a person asked to retry now, so try past a pause that came
  // from an earlier 429 (the self-imposed daily budget still applies).
  async acquire(now = new Date(), opts: AcquireOptions = {}): Promise<void> {
    const key = this.key(now);
    const usage = (await this.store.getQuota(key)) ?? { key, used: 0 };
    const mine = opts.userId ? await this.checkMember(opts.userId, key, usage.used, now) : null;
    if (!opts.ignorePause && usage.exhaustedUntil && new Date(usage.exhaustedUntil) > now) {
      throw new QuotaExhaustedError(new Date(usage.exhaustedUntil), 'Gemini quota exhausted; waiting for capacity.');
    }
    if (usage.used >= this.config.dailyLimit) {
      const until = nextPacificMidnight(now);
      await this.store.setQuota({ ...usage, exhaustedUntil: until.toISOString() });
      throw new QuotaExhaustedError(until, `Daily Gemini budget of ${this.config.dailyLimit} calls used; retrying after the midnight Pacific reset.`);
    }
    const windowStart = now.getTime() - 60_000;
    this.recent = this.recent.filter((t) => t > windowStart);
    if (this.recent.length >= this.config.perMinute) {
      throw new QuotaExhaustedError(new Date(this.recent[0] + 61_000), 'Per-minute Gemini limit reached; retrying shortly.');
    }
    this.recent.push(now.getTime());
    await this.store.setQuota({ ...usage, used: usage.used + 1, exhaustedUntil: undefined });
    if (mine) await this.store.setQuota({ ...mine, used: mine.used + 1 });
  }

  // A member's own count for today, refused when they are over their daily
  // cap or the shared pool is down to the owner's reserve. These pauses are
  // scoped to the member (QuotaExhaustedError.scope) so others keep going.
  private async checkMember(userId: string, key: string, globalUsed: number, now: Date): Promise<{ key: string; used: number }> {
    const userKey = `${key}:user:${userId}`;
    const usage = (await this.store.getQuota(userKey)) ?? { key: userKey, used: 0 };
    const until = nextPacificMidnight(now);
    const { userDaily = 0, ownerReserve = 0 } = this.config;
    if (userDaily > 0 && usage.used >= userDaily) {
      throw new QuotaExhaustedError(until, `Your daily limit of ${userDaily} Gemini calls is used; retrying after the midnight Pacific reset.`, 'user');
    }
    const owner = (await this.store.ownerUserId?.()) ?? null;
    if (ownerReserve > 0 && userId !== owner && globalUsed >= this.config.dailyLimit - ownerReserve) {
      throw new QuotaExhaustedError(until, `The shared Gemini budget is down to the owner's reserve; retrying after the midnight Pacific reset.`, 'user');
    }
    return usage;
  }

  async markExhausted(until: Date, now = new Date()): Promise<void> {
    const key = this.key(now);
    const usage = (await this.store.getQuota(key)) ?? { key, used: 0 };
    await this.store.setQuota({ ...usage, exhaustedUntil: until.toISOString() });
  }
}
