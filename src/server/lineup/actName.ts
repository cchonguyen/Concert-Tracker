// What a lineup's own words say about an act's name, read in code: "A b2b B"
// is two acts playing together, and a "DJ Set" suffix marks the set, not the
// name. Each part is still found verbatim in the quote it came from.
import { normalizeName } from './text';

export interface ActName {
  parts: string[];
  dj: boolean;
}

const DJ_SET = /\s*[-–—:]?\s*[([]?\s*\bdj[\s-]?set\b\s*[)\]]?\s*$/i;
const B2B = /\s+(?:b(?:[2-9]|[/][2-9][/]|ack[\s-]+to[\s-]+)b(?:ack)?|b(?:[2-9]b)+|vs\.?|[xX])\s+/i;

// Festival camp activities, workouts, panels, talks, and non-musical programming
// that should not be extracted as concert or festival lineup acts.
const NON_MUSIC_PROGRAMMING =
  /\b(?:yoga|sound\s+bath|bass\s+restore|campgrounds?\s+5k|5k\s+(?:run|walk)|rockstar\s+workout|workout|main\s+stage\s+moves|water\s+balloon|dating\s+game|win\s+vip|upgrade!|grassroots\s+activism|activis(?:m|t)|storytelling\s+for\s+change|fan's\s+world|sounds\s+of\s+nature|chew\s+on\s+this|planting\s+a\s+flag|solochella|let's\s+be\s+friends|climate\b|sustainability|environmentalist|nutrition|single\s+use\s+plastic|future\s+of\s+food|moderated\s+by|stargazing|ambassador|congressman|united\s+nations|camp\s+city\s+breakers|dr\.\s+[a-z]+|search\s+for\s+life|artists?\s+of\s+nasa|waterworld|chef\s+priyanka|ecokitchen)\b/i;

const PLACEHOLDER = /^\s*\(?\s*(?:surprise|tba|tbd)\s*\)?\s*$/i;

export function isNonMusicProgramming(name: string): boolean {
  return NON_MUSIC_PROGRAMMING.test(name) || PLACEHOLDER.test(name);
}

// Multi-channel silent disco headphone schedules (e.g. "CH 1: DJ Mish; CH 2: Minimize").
const SILENT_DISCO = /\bCH\s*\d+\s*:/i;

export function isSilentDiscoSlot(name: string): boolean {
  return SILENT_DISCO.test(name);
}

function cleanPart(s: string): string {
  let out = s.trim();
  // Strip unmatched leading parenthesis
  if (out.startsWith('(') && !out.includes(')')) {
    out = out.slice(1).trim();
  }
  // Strip unmatched trailing parenthesis
  if (out.endsWith(')') && !out.includes('(')) {
    out = out.slice(0, -1).trim();
  }
  return out;
}

export function readActName(name: string): ActName {
  let rest = name.trim();
  const dj = DJ_SET.test(rest) && rest.replace(DJ_SET, '').trim().length > 0;
  if (dj) rest = rest.replace(DJ_SET, '').trim();

  // If formatted as "Alias/Concept (Artist A b2b Artist B)", unwrap the inner b2b set
  const parenMatch = rest.match(/^([^(]+)\s*\(([^)]+)\)$/);
  if (parenMatch && B2B.test(parenMatch[2])) {
    rest = parenMatch[2].trim();
  }

  const rawParts = rest.split(B2B).map((p) => p.trim()).filter(Boolean);
  const parts = (rawParts.length ? rawParts : [rest]).map(cleanPart).filter(Boolean);
  return { parts: parts.length ? parts : [rest], dj };
}

// The spelling you used before for the same name (any capitalization), else
// the source's, put in Proper Case when it was all one case.
export function preferredSpelling(name: string, yours: Record<string, string>): string {
  const mine = yours[normalizeName(name)];
  if (mine) return mine;
  const letters = name.replace(/[^\p{L}]/gu, '');
  if (!letters || (letters !== letters.toUpperCase() && letters !== letters.toLowerCase())) return name;
  // A one-word all-caps name of up to three letters (MK, ZHU) is kept; so are DJ and MC.
  const words = name.match(/\p{L}[\p{L}\p{N}'’]*/gu) ?? [];
  if (words.length === 1 && letters.length <= 3 && letters === letters.toUpperCase()) return name;
  return name.replace(/\p{L}[\p{L}\p{N}'’]*/gu, (w) => (/^(DJ|MC)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()));
}

// Your spellings, from the acts you saw: the one you used most for each name.
export function yourSpellings(seenNames: string[]): Record<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const n of seenNames) {
    const key = normalizeName(n);
    if (!key) continue;
    const m = counts.get(key) ?? new Map<string, number>();
    m.set(n, (m.get(n) ?? 0) + 1);
    counts.set(key, m);
  }
  const out: Record<string, string> = {};
  for (const [key, m] of counts) out[key] = [...m].sort((a, b) => b[1] - a[1])[0][0];
  return out;
}
