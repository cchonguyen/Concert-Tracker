import type { ExtractedDetails, ExtractedName, GeminiClient, GeminiGenerator } from '../lineup/gemini';
import { QuotaExhaustedError, type QuotaLedger } from '../lineup/quota';
import type { AiCallFeature, AiCallOutcome, AiCallRow, LineupStore } from '../lineup/store/types';
import type { ExtractionExample, LookupInput } from '../lineup/types';
import { logCall } from './callLog';
import { readReaderConfig, type ReaderConfig } from './config';
import { createGeminiReader } from './geminiAdapter';
import { checkGuards, recordOutcome } from './guard';
import { estimateCostUsd } from './pricing';
import { ReaderBusyError, type ReaderClient, type ReaderOutcome, type ReaderResult, type ReaderUsage } from './types';

export interface CallContext<T = unknown> {
  feature: AiCallFeature;
  jobKey: string;
  jobId?: string;
  eventId?: string;
  userId?: string;
  documentId?: string;
  force?: boolean;
  // Runs after the pipeline's verbatim check is known; counts only, never names.
  afterRead?: (value: T) => { returned: number; verbatim: number };
}

export interface GuardedReader {
  readonly provider: string;
  readonly model: string;
  extractPerformers(
    args: { text: string; input: LookupInput; examples: ExtractionExample[]; maxOutputTokens?: number },
    ctx: CallContext<ExtractedName[]>,
  ): Promise<ReaderResult<ExtractedName[]>>;
  extractEventDetails(
    args: { text: string; eventName: string; year?: number; maxOutputTokens?: number },
    ctx: CallContext<ExtractedDetails>,
  ): Promise<ReaderResult<ExtractedDetails>>;
  discoverLineupUrls(input: LookupInput, ctx: CallContext<string[]>): Promise<string[]>;
}

export interface GuardedReaderOptions {
  client: ReaderClient;
  store: LineupStore;
  quota?: QuotaLedger;
  config: ReaderConfig;
  now?: () => Date;
  // Grounded search (Gemini only). Without it discoverLineupUrls returns no URLs.
  discover?: (input: LookupInput) => Promise<string[]>;
}

const DISCOVERY_PROMPT_CHARS = 400;
const DISCOVERY_MAX_OUTPUT_TOKENS = 1024;

export function createGuardedReader(opts: GuardedReaderOptions): GuardedReader {
  const { client, store, quota, config } = opts;
  const clock = opts.now ?? (() => new Date());

  async function run<T>(
    ctx: CallContext<T>,
    inputChars: number,
    maxOutputTokens: number,
    call: () => Promise<{ usage: ReaderUsage | null; ok: boolean; reason?: 'invalid_json' | 'input_too_large'; value?: T }>,
  ): Promise<{ ok: boolean; reason?: 'invalid_json' | 'input_too_large'; value?: T; usage: ReaderUsage | null }> {
    const now = clock();
    const row: AiCallRow = {
      id: crypto.randomUUID(),
      createdAt: now.toISOString(),
      feature: ctx.feature,
      jobId: ctx.jobId ?? null,
      eventId: ctx.eventId ?? null,
      userId: ctx.userId ?? null,
      provider: client.provider,
      model: client.model,
      sourceDocumentId: ctx.documentId ?? null,
      inputChars,
      inputTokens: null,
      outputTokens: null,
      estCostUsd: null,
      durationMs: null,
      outcome: 'error',
      errorCode: null,
      guardReason: null,
      namesReturned: null,
      namesVerbatim: null,
      namesRejected: null,
    };
    let guard;
    try {
      guard = await checkGuards({
        store, config, provider: client.provider, model: client.model, inputChars, maxOutputTokens,
        jobKey: ctx.jobKey, quota, now, force: ctx.force, quotaOptions: { userId: ctx.userId },
      });
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        row.outcome = 'blocked_by_guard';
        row.guardReason = err.reason;
        await logCall(store, row, now);
      } else {
        row.errorCode = errName(err);
        await logCall(store, row, now);
      }
      throw err;
    }
    if (!guard.ok) {
      row.outcome = 'blocked_by_guard';
      row.guardReason = guard.reason;
      row.inputTokens = 0;
      row.outputTokens = 0;
      row.durationMs = 0;
      await logCall(store, row, now);
      return { ok: false, reason: guard.reason, usage: guard.usage };
    }

    const settle = async (outcome: ReaderOutcome, usage: ReaderUsage | null, retryAt?: Date) => {
      try {
        await recordOutcome({
          store, config, provider: client.provider, model: client.model, outcome,
          usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null,
          worstCaseMicroUsd: guard.worstCaseMicroUsd, retryAt, now,
        });
      } catch {
        // The call is already made and paid for; the next pre-call check fails closed if the ledger is down.
      }
    };
    const fill = (usage: ReaderUsage) => {
      row.inputTokens = usage.inputTokens;
      row.outputTokens = usage.outputTokens;
      row.durationMs = usage.durationMs;
      row.estCostUsd = estimateCostUsd(usage.provider, usage.model, usage);
    };

    const started = Date.now();
    try {
      const res = await call();
      if (res.usage) fill(res.usage);
      if (res.ok) {
        row.outcome = 'ok';
        await settle('success', res.usage);
        if (ctx.afterRead && res.value !== undefined) {
          try {
            const c = ctx.afterRead(res.value);
            row.namesReturned = c.returned;
            row.namesVerbatim = c.verbatim;
            row.namesRejected = Math.max(0, c.returned - c.verbatim);
          } catch {
            // counts stay null
          }
        }
      } else {
        row.outcome = 'invalid_json';
        row.errorCode = res.reason ?? null;
        await settle('invalid_json', res.usage);
      }
      await logCall(store, row, now);
      return res;
    } catch (err) {
      row.durationMs = Date.now() - started;
      let outcome: ReaderOutcome = 'error';
      let logged: AiCallOutcome = 'error';
      let retryAt: Date | undefined;
      if (err instanceof QuotaExhaustedError) {
        outcome = 'quota';
        logged = 'quota';
        retryAt = err.retryAt;
        row.guardReason = err.reason;
      } else if (err instanceof ReaderBusyError) {
        outcome = 'busy';
        logged = 'busy';
      } else {
        row.errorCode = errName(err);
      }
      row.outcome = logged;
      await settle(outcome, null, retryAt);
      await logCall(store, row, now);
      throw err;
    }
  }

  return {
    provider: client.provider,
    model: client.model,

    async extractPerformers(args, ctx) {
      const maxOutputTokens = args.maxOutputTokens ?? config.maxOutputTokens;
      const res = await run<ExtractedName[]>(ctx, args.text.length, maxOutputTokens, () =>
        client.extractPerformers({ ...args, maxOutputTokens }),
      );
      return res as ReaderResult<ExtractedName[]>;
    },

    async extractEventDetails(args, ctx) {
      const maxOutputTokens = args.maxOutputTokens ?? config.maxOutputTokensDetails;
      const res = await run<ExtractedDetails>(ctx, args.text.length, maxOutputTokens, () =>
        client.extractEventDetails({ ...args, maxOutputTokens }),
      );
      return res as ReaderResult<ExtractedDetails>;
    },

    async discoverLineupUrls(input, ctx) {
      if (!opts.discover) return [];
      const discover = opts.discover;
      let urls: string[] = [];
      await run<string[]>(ctx, DISCOVERY_PROMPT_CHARS, DISCOVERY_MAX_OUTPUT_TOKENS, async () => {
        const started = Date.now();
        urls = await discover(input);
        // The provider reports no usage for grounded search, so cost is the worst case (null tokens).
        const usage: ReaderUsage = { provider: client.provider, model: client.model, inputTokens: null, outputTokens: null, durationMs: Date.now() - started };
        return { ok: true, usage, value: urls };
      });
      return urls;
    },
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

export function guardedFromGemini(
  gemini: GeminiClient & GeminiGenerator,
  store: LineupStore,
  quota?: QuotaLedger,
  now: () => Date = () => new Date(),
  config: ReaderConfig = readReaderConfig({}),
): GuardedReader {
  return createGuardedReader({
    client: createGeminiReader(gemini, config.thinkingLevel, now, config.windowChars),
    store,
    quota,
    config,
    now,
    discover: (input) => gemini.discoverLineupUrls(input),
  });
}
