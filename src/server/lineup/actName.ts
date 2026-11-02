// What a lineup's own words say about an act's name, read in code: "A b2b B"
// is two acts playing together, and a "DJ Set" suffix marks the set, not the
// name. Each part is still found verbatim in the quote it came from.
import { normalizeName } from './text';

export interface ActName {
  parts: string[];
  dj: boolean;
}

const DJ_SET = /\s*[-–—:]?\s*[([]?\s*\bdj[\s-]?set\b\s*[)\]]?\s*$/i;
const B2B = /\s+(?:b(?:2|[/]2[/]|ack[\s-]+to[\s-]+)b(?:ack)?|vs\.?)\s+/i;

export function readActName(name: string): ActName {
  let rest = name.trim();
  const dj = DJ_SET.test(rest) && rest.replace(DJ_SET, '').trim().length > 0;
  if (dj) rest = rest.replace(DJ_SET, '').trim();
  const parts = rest.split(B2B).map((p) => p.trim()).filter(Boolean);
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
