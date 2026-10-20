import path from 'node:path';
import { getSupabaseClient } from '../supabase';
import { createRateLimitedFetcher } from './http';
import { createGeminiClient } from './gemini';
import { QuotaLedger } from './quota';
import { FileLineupStore } from './store/fileStore';
import { SupabaseLineupStore } from './store/supabaseStore';
import { LineupStore } from './store/types';
import { clashfinderAdapter } from './adapters/clashfinder';
import { promoterAdapter } from './adapters/promoter';
import { ticketmasterAdapter } from './adapters/ticketmaster';
import { setlistfmAdapter } from './adapters/setlistfm';
import { PipelineDeps, runJob } from './pipeline';

// Wires the pipeline from environment variables. See .env.example.

// Supabase is the durable store. The local file store is for development and
// is used when Supabase is not configured or its lineup tables are missing.
export async function createStore(): Promise<LineupStore> {
  const fileStore = () => new FileLineupStore(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'));
  if (process.env.LINEUP_STORE === 'file') return fileStore();
  const client = getSupabaseClient();
  if (!client) return fileStore();
  const probe = await client.from('lookup_jobs').select('id').limit(1);
  if (probe.error) {
    console.warn(
      `Supabase lineup tables unavailable (${probe.error.message}). Apply supabase/migrations/0002_source_first_lineups.sql. Using the local file store.`,
    );
    return fileStore();
  }
  return new SupabaseLineupStore(client);
}

export function createDeps(store: LineupStore): PipelineDeps {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-flash-lite-latest';
  const geminiReady = Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
  return {
    store,
    fetcher: createRateLimitedFetcher(),
    adapters: [clashfinderAdapter, promoterAdapter, ticketmasterAdapter],
    lateAdapters: [setlistfmAdapter],
    gemini: geminiReady ? createGeminiClient(apiKey!, model) : null,
    quota: geminiReady
      ? new QuotaLedger(store, {
          provider: 'gemini',
          model,
          dailyLimit: Number(process.env.GEMINI_DAILY_LIMIT || 50),
          perMinute: Number(process.env.GEMINI_PER_MINUTE || 10),
        })
      : null,
    allowDiscovery: process.env.GEMINI_SEARCH_DISCOVERY !== 'off',
    now: () => new Date(),
  };
}

// Single-process worker: picks up due jobs on an interval, one at a time.
export class LookupWorker {
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
    gemini: deps.gemini ? { model: deps.gemini.model, discovery: deps.allowDiscovery } : null,
  };
}
