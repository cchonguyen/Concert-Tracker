import { GoogleGenAI, Type } from '@google/genai';
import { ExtractionExample, LookupInput } from './types';
import { lineupWindow } from './text';
import { parseRateLimitError } from './quota';

// Gemini is a reader, never a memory. It only extracts names from text the
// app fetched, and must quote the span each name came from; the caller drops
// any name whose quote is not in the document. It is never asked for
// confidence scores, dates it was not shown, or URLs it did not find.

export interface ExtractedName {
  name: string;
  quote: string;
  day?: string;
  stage?: string;
  billing?: string; // 'headliner' | 'support', only when the quote says so
}

export interface GeminiClient {
  readonly model: string;
  extractPerformers(args: {
    text: string;
    input: LookupInput;
    examples: ExtractionExample[];
  }): Promise<ExtractedName[]>;
  // Grounded search used only to find candidate lineup URLs.
  discoverLineupUrls(input: LookupInput): Promise<string[]>;
}

// @5: an optional billing role, kept only when the quote states it.
export const EXTRACTION_PROMPT_VERSION = 'extract@5';
const MAX_DOC_CHARS = 40000;

const SYSTEM = `You copy performer names out of a web page. Rules:
- Use only the PAGE TEXT provided. Never use outside knowledge, never guess, never complete a partial lineup.
- For every name, "quote" must be an exact substring of the page text (up to 200 characters) that contains the name.
- Include only acts that perform (artists, DJs, bands, b2b pairings as written). Exclude stage names, day labels, sponsors, ticket tiers, menu items and navigation.
- Include only acts billed for the EVENT in the year named below, across all of its days and stages. Pages, including the event's own site, often also list other events, other dates or cities of the same brand, past or upcoming editions, tours or recommended artists; leave all of those out.
- Copy names exactly as written on the page, including capitalisation and punctuation.
- Set "day" (YYYY-MM-DD) or "stage" only when the page text states it for that act.
- Set "billing" to "headliner" or "support" only when the page text itself bills the act that way (for example "Headliners:", "Support:", "special guest", "X with Y"), and then make "quote" include those words. Never infer it from order, size or fame.
- If the page has no lineup, return an empty list.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    performers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          quote: { type: Type.STRING },
          day: { type: Type.STRING },
          stage: { type: Type.STRING },
          billing: { type: Type.STRING, enum: ['headliner', 'support'] },
        },
        required: ['name', 'quote'],
      },
    },
  },
  required: ['performers'],
};

function rethrowQuota(err: unknown): never {
  throw parseRateLimitError(err, new Date()) ?? err;
}

export function createGeminiClient(apiKey: string, model: string): GeminiClient {
  const ai = new GoogleGenAI({ apiKey });

  return {
    model,

    async extractPerformers({ text, input, examples }) {
      const parts: string[] = [`EVENT: ${input.eventName} (${input.year})`];
      for (const ex of examples.slice(0, 1)) {
        parts.push(
          `EXAMPLE from an earlier page on the same website, with the lineup a person confirmed:\nPAGE TEXT:\n${ex.excerpt}\nCONFIRMED NAMES: ${ex.names.join(' | ')}`,
        );
      }
      parts.push(`PAGE TEXT:\n${lineupWindow(text, MAX_DOC_CHARS)}`);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: parts.join('\n\n'),
          config: {
            systemInstruction: SYSTEM,
            responseMimeType: 'application/json',
            responseSchema: SCHEMA,
            temperature: 0,
          },
        });
        const parsed = JSON.parse(response.text ?? '{"performers":[]}');
        return Array.isArray(parsed.performers) ? parsed.performers : [];
      } catch (err) {
        if (err instanceof SyntaxError) return [];
        rethrowQuota(err);
      }
    },

    async discoverLineupUrls(input) {
      const where = [input.venue, input.city].filter(Boolean).join(', ');
      const prompt = `Find web pages that list the full lineup of performing artists for "${input.eventName}" in ${input.year}${where ? ` (${where})` : ''}. Prefer the official festival or promoter site and Clashfinder. Reply with URLs only, one per line.`;
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { tools: [{ googleSearch: {} }], temperature: 0 },
        });
        const urls = new Set<string>();
        for (const chunk of response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
          if (chunk.web?.uri) urls.add(chunk.web.uri);
        }
        for (const m of (response.text ?? '').matchAll(/https?:\/\/[^\s)>\]"']+/g)) urls.add(m[0]);
        return [...urls].slice(0, 3);
      } catch (err) {
        rethrowQuota(err);
      }
    },
  };
}
