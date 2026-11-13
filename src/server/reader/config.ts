import type { ReaderProvider, ThinkingLevel } from './types';

export interface ReaderConfig {
  provider: ReaderProvider | null; // null when READER_PROVIDER is set to an unknown value (no reader)
  providerExplicit: boolean; // READER_PROVIDER was set (used by the unpinned-model guard)
  enabled: boolean; // kill switch: unset or READER_ENABLED=on lets calls through; any other value blocks
  thinkingLevel: ThinkingLevel;
  geminiModel: string;
  workersAiModel: string;
  maxInputChars: number;
  windowChars: number;
  breakerFailures: number;
  breakerCooldownMin: number;
  maxCallsPerJob: number;
  maxSpendDayUsd: number;
  maxSpendMonthUsd: number;
  maxOutputTokens: number;
  maxOutputTokensDetails: number;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_WORKERS_AI_MODEL = '@cf/zai-org/glm-4.7-flash';

type Env = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function num(v: unknown, fallback: number): number {
  const s = str(v);
  if (s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function int(v: unknown, fallback: number): number {
  const n = num(v, fallback);
  return Number.isInteger(n) ? n : fallback;
}

const LEVELS: ThinkingLevel[] = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'OFF'];

// Reads env on every call so dashboard changes apply without a redeploy.
export function readReaderConfig(env: Env): ReaderConfig {
  const rawProvider = str(env.READER_PROVIDER);
  const lowered = rawProvider?.toLowerCase();
  const provider: ReaderProvider | null =
    rawProvider === undefined ? 'gemini' : lowered === 'gemini' || lowered === 'workers-ai' ? lowered : null;
  const level = str(env.READER_THINKING_LEVEL)?.toUpperCase() as ThinkingLevel | undefined;
  return {
    provider,
    providerExplicit: rawProvider !== undefined,
    // Unset keeps the reader on, so behavior is unchanged until Charlie sets the switch; any other value blocks.
    enabled: (str(env.READER_ENABLED) ?? 'on').toLowerCase() === 'on',
    thinkingLevel: level && LEVELS.includes(level) ? level : 'LOW',
    geminiModel: str(env.GEMINI_EXTRACTION_MODEL) ?? DEFAULT_GEMINI_MODEL,
    workersAiModel: str(env.WORKERS_AI_MODEL) ?? DEFAULT_WORKERS_AI_MODEL,
    maxInputChars: int(env.READER_MAX_INPUT_CHARS, 200000),
    windowChars: int(env.READER_WINDOW_CHARS, 180000),
    breakerFailures: int(env.READER_BREAKER_FAILURES, 5),
    breakerCooldownMin: num(env.READER_BREAKER_COOLDOWN_MIN, 30),
    maxCallsPerJob: int(env.READER_MAX_CALLS_PER_JOB, 6),
    maxSpendDayUsd: num(env.READER_MAX_SPEND_DAY_USD, 0.5),
    maxSpendMonthUsd: num(env.READER_MAX_SPEND_MONTH_USD, 5),
    maxOutputTokens: int(env.READER_MAX_OUTPUT_TOKENS, 8192),
    maxOutputTokensDetails: int(env.READER_MAX_OUTPUT_TOKENS_DETAILS, 1024),
  };
}
