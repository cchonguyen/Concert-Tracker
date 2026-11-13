import type { ExtractedName, ExtractedDetails } from '../lineup/gemini';
import type { ExtractionExample, LookupInput } from '../lineup/types';

export type ReaderProvider = 'gemini' | 'workers-ai';

export interface ReaderUsage {
  provider: ReaderProvider;
  model: string;
  inputTokens: number | null; // null when the provider did not report it
  outputTokens: number | null; // includes thinking tokens
  durationMs: number;
}

export type ReaderResult<T> =
  | { ok: true; value: T; usage: ReaderUsage }
  | { ok: false; reason: 'invalid_json' | 'input_too_large'; usage: ReaderUsage };

export interface ReaderClient {
  readonly provider: ReaderProvider;
  readonly model: string;
  extractPerformers(args: { text: string; input: LookupInput; examples: ExtractionExample[]; maxOutputTokens: number }): Promise<ReaderResult<ExtractedName[]>>;
  extractEventDetails(args: { text: string; eventName: string; year?: number; maxOutputTokens: number }): Promise<ReaderResult<ExtractedDetails>>;
}

// Thrown (not returned) when the provider is busy; the job's normal attempts path handles it.
export class ReaderBusyError extends Error {
  constructor(message = 'The reader is busy; try again shortly.') {
    super(message);
    this.name = 'ReaderBusyError';
  }
}

export type ThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'OFF';

// QuotaExhaustedError lives in ../lineup/quota (existing); re-exported for reader code.
export { QuotaExhaustedError } from '../lineup/quota';

// How a guarded call ended, as reported to recordOutcome.
// 'quota' is a provider 402/429 quota error; 'busy' is ReaderBusyError.
export type ReaderOutcome = 'success' | 'error' | 'invalid_json' | 'busy' | 'quota';
