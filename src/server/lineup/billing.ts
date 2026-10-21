import { normalizeName } from './text';

// Billing roles, read in code from words a source wrote. A listing called
// "Porter Robinson with special guest Wavedash" names a lead and a support act;
// "Porter Robinson" or a festival lineup names no lead, so its acts get no role.
// A role is only ever set when the title has a marker word and billed acts on
// both sides of it (REQUIREMENTS.md, Artist and Supporting artists).

export type Billing = 'headliner' | 'support';

// Longest first, so "with special guests" wins over "with".
const MARKER =
  /\s+(?:(?:with|and|plus|\+)\s+(?:very\s+)?special\s+guests?|(?:very\s+)?special\s+guests?|supported\s+by|support\s+from|w\/|with|plus)\s*[:-]?\s+/i;

export interface SplitBill {
  head: string; // the words before the marker
  tail: string; // the words after it
  marker: string;
}

export function splitBill(title: string): SplitBill | null {
  const m = MARKER.exec(` ${title.trim()} `);
  if (!m) return null;
  const text = ` ${title.trim()} `;
  return { head: text.slice(0, m.index).trim(), tail: text.slice(m.index + m[0].length).trim(), marker: m[0].trim() };
}

const contains = (text: string, name: string) => ` ${normalizeName(text)} `.includes(` ${name} `);

// Where each named act sits in the title: before the marker, after it, or
// neither. Names are matched whole-word after normalization.
export function placeInTitle(title: string, names: string[]): Map<string, 'head' | 'tail' | 'both' | 'none'> {
  const split = splitBill(title);
  const out = new Map<string, 'head' | 'tail' | 'both' | 'none'>();
  for (const raw of names) {
    const n = normalizeName(raw);
    if (!n) continue;
    if (!split) {
      out.set(n, contains(title, n) ? 'head' : 'none');
      continue;
    }
    const h = contains(split.head, n);
    const t = contains(split.tail, n);
    out.set(n, h && t ? 'both' : h ? 'head' : t ? 'tail' : 'none');
  }
  return out;
}

// Roles for the given acts from one title. Keys are normalized names. Empty
// unless the title has a marker with a named act before it and after it, so
// "An Evening with X" gives X no role.
export function billingFromTitle(title: string, names: string[]): Map<string, Billing> {
  const out = new Map<string, Billing>();
  if (!splitBill(title)) return out;
  const places = placeInTitle(title, names);
  const values = [...places.values()];
  if (!values.includes('head') || !values.includes('tail')) return out;
  for (const [n, p] of places) {
    if (p === 'head') out.set(n, 'headliner');
    else if (p === 'tail') out.set(n, 'support');
  }
  return out;
}

const ROLE_WORDS = /\b(headlin(?:ers?|ing|e))\b|\b(support(?:ing)?(?:\s+acts?)?|special\s+guests?|openers?|opening\s+acts?)\b/gi;

// Whether a quoted span from a page itself bills the act as claimed: the
// nearest role word before the act ("Headliners: A, B", "Support: C",
// "special guest D") names that role, or a marker puts the act on the matching
// side ("X with Y"). A reader's role without such words in its quote is
// dropped, like a name not on the page.
export function quoteBacksBilling(quote: string, name: string, billing: Billing): boolean {
  const n = normalizeName(name);
  if (!n || !contains(quote, n)) return false;
  const at = quote.toLowerCase().indexOf(name.toLowerCase().trim());
  let nearest: Billing | undefined;
  if (at >= 0) {
    for (const m of quote.matchAll(ROLE_WORDS)) {
      if (m.index! >= at) break;
      nearest = m[1] ? 'headliner' : 'support';
    }
  }
  if (nearest) return nearest === billing;
  const split = splitBill(quote);
  if (!split) return false;
  const [mine, other] = billing === 'headliner' ? [split.head, split.tail] : [split.tail, split.head];
  return contains(mine, n) && !contains(other, n);
}

export const isBilling = (v: unknown): v is Billing => v === 'headliner' || v === 'support';
