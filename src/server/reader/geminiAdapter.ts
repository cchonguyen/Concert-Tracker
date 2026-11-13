import { DETAILS_SCHEMA, DETAILS_SYSTEM, SCHEMA, SYSTEM, buildDetailsContents, buildExtractionContents } from '../lineup/gemini';
import type { ExtractedDetails, ExtractedName, GeminiGenerateResult, GeminiGenerator } from '../lineup/gemini';
import { QuotaExhaustedError, parseRateLimitError } from '../lineup/quota';
import type { ReaderClient, ReaderResult, ReaderUsage, ThinkingLevel } from './types';

const DETAIL_FIELDS = ['dateQuote', 'venue', 'city', 'country', 'placeQuote'] as const;
const EMPTY_BALANCE_WAIT_MS = 6 * 60 * 60 * 1000;

export function thinkingConfigFor(model: string, level: ThinkingLevel): { thinkingBudget: number } | { thinkingLevel: string } {
  if (model.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  return { thinkingLevel: level === 'OFF' ? 'LOW' : level };
}

function mapError(err: unknown, now: Date): unknown {
  const e = err as { status?: number; code?: number; message?: string };
  const message = typeof e?.message === 'string' ? e.message : '';
  if (e?.status === 402 || e?.code === 402 || /prepayment credits are depleted|billing.*depleted/i.test(message)) {
    return new QuotaExhaustedError(new Date(now.getTime() + EMPTY_BALANCE_WAIT_MS), 'Gemini prepay balance is empty; add credit in Google AI Studio.');
  }
  return parseRateLimitError(err, now) ?? err;
}

export function createGeminiReader(client: GeminiGenerator, thinkingLevel: ThinkingLevel = 'LOW', now: () => Date = () => new Date(), windowChars?: number): ReaderClient {
  async function read<T>(
    args: { contents: string; systemInstruction: string; schema: unknown; maxOutputTokens: number },
    check: (parsed: unknown) => T | null,
  ): Promise<ReaderResult<T>> {
    const started = Date.now();
    let res: GeminiGenerateResult;
    try {
      res = await client.generate({ ...args, thinkingConfig: thinkingConfigFor(client.model, thinkingLevel) });
    } catch (err) {
      throw mapError(err, now());
    }
    const usage: ReaderUsage = {
      provider: 'gemini',
      model: client.model,
      inputTokens: res.promptTokens,
      outputTokens: res.candidatesTokens === null && res.thoughtsTokens === null ? null : (res.candidatesTokens ?? 0) + (res.thoughtsTokens ?? 0),
      durationMs: Date.now() - started,
    };
    if (res.finishReason === 'MAX_TOKENS') return { ok: false, reason: 'invalid_json', usage };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return { ok: false, reason: 'invalid_json', usage };
    }
    const value = check(parsed);
    return value === null ? { ok: false, reason: 'invalid_json', usage } : { ok: true, value, usage };
  }

  return {
    provider: 'gemini',
    model: client.model,

    extractPerformers({ text, input, examples, maxOutputTokens }) {
      return read<ExtractedName[]>(
        { contents: buildExtractionContents(input, text, examples, windowChars), systemInstruction: SYSTEM, schema: SCHEMA, maxOutputTokens },
        (p) => {
          const list = (p as { performers?: unknown } | null)?.performers;
          return Array.isArray(list) ? (list as ExtractedName[]) : null;
        },
      );
    },

    extractEventDetails({ text, eventName, year, maxOutputTokens }) {
      return read<ExtractedDetails>(
        { contents: buildDetailsContents(eventName, year, text, windowChars), systemInstruction: DETAILS_SYSTEM, schema: DETAILS_SCHEMA, maxOutputTokens },
        (p) => {
          if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
          const out: Record<string, string> = {};
          for (const k of DETAIL_FIELDS) {
            const v = (p as Record<string, unknown>)[k];
            if (v === undefined || v === null) continue;
            if (typeof v !== 'string') return null;
            out[k] = v;
          }
          return out as ExtractedDetails;
        },
      );
    },
  };
}
