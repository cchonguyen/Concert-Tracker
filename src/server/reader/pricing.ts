import type { ReaderProvider } from './types';

export interface Price {
  inPerMillion: number; // USD per million input tokens
  outPerMillion: number; // USD per million output tokens
  checkedOn?: string;
}

// Known models, keyed `${provider}:${model}`. No other model is listed; unlisted ones use FALLBACK_PRICES.
export const PRICES: Record<string, Price> = {
  'gemini:gemini-3.5-flash-lite': { inPerMillion: 0.3, outPerMillion: 2.5, checkedOn: '2026-11-13' },
  'workers-ai:@cf/zai-org/glm-4.7-flash': { inPerMillion: 0.06, outPerMillion: 0.4, checkedOn: '2026-11-13' },
  'workers-ai:@cf/google/gemma-4-26b-a4b-it': { inPerMillion: 0.1, outPerMillion: 0.3, checkedOn: '2026-11-13' },
};

// Sized so an unlisted model never underestimates.
export const FALLBACK_PRICES: Record<ReaderProvider, Price> = {
  gemini: { inPerMillion: 1.5, outPerMillion: 7.5 },
  'workers-ai': { inPerMillion: 0.1, outPerMillion: 0.4 },
};

export function priceFor(provider: ReaderProvider, model: string): { price: Price; isFallback: boolean } {
  const known = PRICES[`${provider}:${model}`];
  return known ? { price: known, isFallback: false } : { price: FALLBACK_PRICES[provider], isFallback: true };
}

export function estimateCostUsd(
  provider: ReaderProvider,
  model: string,
  usage: { inputTokens: number | null; outputTokens: number | null },
): number | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const { price } = priceFor(provider, model);
  return (usage.inputTokens * price.inPerMillion + usage.outputTokens * price.outPerMillion) / 1_000_000;
}

// One token at P dollars per million costs P micro-dollars.
export function worstCaseMicroUsd(
  provider: ReaderProvider,
  model: string,
  inputChars: number,
  maxOutputTokens: number,
): { micro: number; isFallback: boolean } {
  const { price, isFallback } = priceFor(provider, model);
  const micro = Math.ceil(Math.ceil(inputChars / 3) * price.inPerMillion + maxOutputTokens * price.outPerMillion);
  return { micro, isFallback };
}
