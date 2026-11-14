import path from 'node:path';
import { getSupabaseClient } from '../supabase';
import { createRateLimitedFetcher } from './http';
import { createGeminiClient } from './gemini';
import { QuotaLedger } from './quota';
import { cachingFetcher } from './responseCache';
import { braveCapFetcher } from '../events/braveBudget';
import { withEntityLinks } from '../entities/linkingStore';
import { FileLineupStore } from './store/fileStore';
import { SupabaseLineupStore } from './store/supabaseStore';
import { LineupStore } from './store/types';
import { clashfinderAdapter } from './adapters/clashfinder';
import { promoterAdapter } from './adapters/promoter';
import { ticketmasterAdapter } from './adapters/ticketmaster';
import { setlistfmAdapter } from './adapters/setlistfm';
import { PipelineDeps, runJob } from './pipeline';
import { braveSearch, geminiSearch, LineupSearch } from './search';
import { readReaderConfig } from '../reader/config';
import { guardedFromGemini, type GuardedReader } from '../reader/guardedReader';

// Wires the pipeline from environment variables. See .env.example.

// Supabase is the durable store. The local file store is for development and
// is used when Supabase is not configured or its lineup tables are missing.
// Hosts without a persistent disk (Cloudflare Workers) pass requireSupabase,
// so a missing database fails loudly instead of losing data.
export async function createStore(opts: { requireSupabase?: boolean } = {}): Promise<LineupStore> {
  const fileStore = () => new FileLineupStore(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'));
  if (!opts.requireSupabase && process.env.LINEUP_STORE === 'file') return withEntityLinks(fileStore());
  const client = getSupabaseClient();
  if (!client) {
    if (opts.requireSupabase) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required on this host.');
    return withEntityLinks(fileStore());
  }
  // Probe one table from each migration so a missing one fails clearly.
  for (const [table, migration] of [
    ['lookup_jobs', '0002_source_first_lineups.sql'],
    ['logged_events', '0003_event_log.sql'],
  ]) {
    const probe = await client.from(table).select('id').limit(1);
    if (!probe.error) continue;
    const message = `Supabase table ${table} unavailable (${probe.error.message}). Apply supabase/migrations/${migration}.`;
    if (opts.requireSupabase) throw new Error(message);
    console.warn(`${message} Using the local file store.`);
    return withEntityLinks(fileStore());
  }
  const store = new SupabaseLineupStore(client);
  // The entity tables (0014) are optional for now: without them events save
  // with their names only, as before.
  const entities = await client.from('entities').select('id').limit(1);
  if (entities.error) {
    console.warn(`Supabase table entities unavailable (${entities.error.message}). Apply supabase/migrations/0014_entities.sql; saving events without record IDs until then.`);
    return store;
  }
  return withEntityLinks(store);
}

// Builds the guarded reader from env read at call time, so a model or provider
// swap in the dashboard applies without a redeploy. Null means no reader:
// an unknown provider, workers-ai (its adapter does not exist yet), or no key.
export function createReader(
  store: LineupStore,
  env: Record<string, unknown> = process.env,
  quota?: QuotaLedger | null,
): GuardedReader | null {
  const config = readReaderConfig(env);
  if (config.provider !== 'gemini') return null;
  const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY : undefined;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return guardedFromGemini(createGeminiClient(apiKey, config.geminiModel), store, quota ?? undefined, undefined, config);
}

export function createDeps(store: LineupStore): PipelineDeps {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-flash-lite-latest';
  const multiUser = process.env.MULTI_USER === 'on';
  const geminiReady = Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
  // SOURCE_CACHE=on keeps Ticketmaster responses 24 hours (responseCache.ts).
  const rawFetcher = process.env.SOURCE_CACHE === 'on' ? cachingFetcher(createRateLimitedFetcher(), store) : createRateLimitedFetcher();
  // Brave requests take one of the 200 monthly queries first (braveBudget.ts). Brave is never cached.
  const fetcher = braveCapFetcher(rawFetcher, store);
  const gemini = geminiReady ? createGeminiClient(apiKey!, model) : null;
  // Brave when configured; otherwise Gemini grounded search, which needs a
  // billed Gemini project and can be turned off with GEMINI_SEARCH_DISCOVERY=off.
  let search: LineupSearch | null = null;
  if (process.env.BRAVE_SEARCH_API_KEY) search = braveSearch(fetcher, process.env.BRAVE_SEARCH_API_KEY);
  else if (gemini && process.env.GEMINI_SEARCH_DISCOVERY !== 'off') search = geminiSearch(gemini);
  const quotaLedger = geminiReady
    ? new QuotaLedger(store, {
        provider: 'gemini',
        model,
        dailyLimit: Number(process.env.GEMINI_DAILY_LIMIT || 50),
        perMinute: Number(process.env.GEMINI_PER_MINUTE || 10),
        // With MULTI_USER=on the recommended caps apply unless set: 20 calls
        // kept for the owner, 5 interactive and 3 background calls per member.
        ownerReserve: Number(process.env.GEMINI_OWNER_RESERVE || (multiUser ? 20 : 0)),
        userDaily: Number(process.env.GEMINI_USER_DAILY || (multiUser ? 5 : 0)),
        userBackfillDaily: Number(process.env.GEMINI_USER_BACKFILL_DAILY || (multiUser ? 3 : 0)),
      })
    : null;
  return {
    store,
    fetcher,
    adapters: [clashfinderAdapter, promoterAdapter, ticketmasterAdapter],
    lateAdapters: [setlistfmAdapter],
    gemini,
    quota: quotaLedger,
    reader: createReader(store, process.env, quotaLedger),
    search,
    now: () => new Date(),
  };
}

// Starts a job without making the caller wait for it; callers poll the job record.
export interface JobRunner {
  kick(jobId: string, force?: boolean): void | Promise<void>;
}

// Single-process worker: picks up due jobs on an interval, one at a time.
// Cloudflare uses a Cron Trigger and a Queue instead (worker/index.ts).
export class LookupWorker implements JobRunner {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  start(intervalMs = 20000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    try {
      const due = await this.deps.store.dueJobs(this.deps.now(), 5);
      for (const job of due) await this.run(job.id);
    } catch (err) {
      console.warn('Lookup worker tick failed:', err);
    }
  }

  async run(jobId: string, force = false): Promise<void> {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);
    try {
      await runJob(this.deps, jobId, { force });
    } finally {
      this.running.delete(jobId);
    }
  }

  // Starts a job without waiting for it; callers poll the job record.
  kick(jobId: string, force = false): void {
    void this.run(jobId, force);
  }
}

export function configuredSources(deps: PipelineDeps) {
  return {
    store: deps.store.kind,
    sources: [...deps.adapters, ...deps.lateAdapters].map((a) => ({ id: a.id, enabled: a.enabled() })),
    gemini: deps.gemini ? { model: deps.gemini.model, discovery: Boolean(deps.search) } : null,
    search: deps.search?.id ?? null,
  };
}
