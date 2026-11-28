// Ticket stub rules (docs/archive/ticket-stub.md, Rules). Pure code: no React,
// no I/O, no clock. Callers pass `today` in. Every printed value is stored or
// worked out here from stored values; a missing one is left out.

import type { Billing } from '../server/lineup/billing';
import { wentTo } from '../server/events/attendance';

export type TicketAct = { name: string; role?: Billing; inferred?: boolean };

export interface TicketLines {
  big: string[];
  bigIsEvent: boolean;
  showEventLine: boolean;
  small: string[];
  moreHeadliners: number;
  askWhoSaw: boolean;
}

// Compare text ignoring case, punctuation and repeated spaces.
const sameText = (a: string, b: string): boolean => {
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
};

// The big and small lines on a ticket. Headliners come only from a stored or
// inferred role, never from list order.
export function ticketLines(eventName: string, acts: TicketAct[]): TicketLines {
  const askWhoSaw = acts.length === 0;
  const anyRole = acts.some((a) => a.role !== undefined);
  const headIdx = acts.map((a, i) => (a.role === 'headliner' ? i : -1)).filter((i) => i >= 0);

  let bigIdx: number[] = [];
  let bigIsEvent = false;
  let moreHeadliners = 0;
  const hidden = new Set<number>();

  if (acts.length === 0) {
    bigIsEvent = true;
  } else if (headIdx.length === 1 || headIdx.length === 2) {
    bigIdx = headIdx;
  } else if (headIdx.length >= 3) {
    bigIdx = headIdx.slice(0, 2);
    moreHeadliners = headIdx.length - 2;
    for (const i of headIdx.slice(2)) hidden.add(i);
  } else if (!anyRole && acts.length <= 2) {
    bigIdx = acts.map((_, i) => i);
  } else {
    bigIsEvent = true;
  }

  const big = bigIsEvent ? [eventName] : bigIdx.map((i) => acts[i].name);
  const rest = acts.map((_, i) => i).filter((i) => !bigIdx.includes(i) && !hidden.has(i));
  const supports = rest.filter((i) => acts[i].role === 'support');
  const others = rest.filter((i) => acts[i].role !== 'support');
  const small = [...supports, ...others].map((i) => acts[i].name);

  const showEventLine = !bigIsEvent && !sameText(eventName, big.join(' & '));

  return { big, bigIsEvent, showEventLine, small, moreHeadliners, askWhoSaw };
}

// The admit count on the stub: you, plus each non-blank name in "With".
export function admitCount(companions: string[]): number {
  return 1 + companions.filter((c) => c.trim() !== '').length;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Boxed date parts. A full date gives [MM, DD, YY]; a month only gives [MON, YY];
// a year only, or nothing, gives null.
export function shortDate(e: { startDate?: string; year?: number; month?: number }): string[] | null {
  if (e.startDate && /^\d{4}-\d{2}-\d{2}$/.test(e.startDate)) {
    const [y, m, d] = e.startDate.split('-');
    return [m, d, y.slice(-2)];
  }
  if (e.year !== undefined && e.month !== undefined && e.month >= 1 && e.month <= 12) {
    return [MONTHS[e.month - 1], String(e.year).slice(-2)];
  }
  return null;
}

const VOWELS = /[AEIOU]/g;

// A short uppercase code for the stub, drawn from the text only. Each word keeps
// its first letter and drops its later vowels; words are joined and cut to len.
// If that is under 3 characters, the first len letters and digits are used.
// Output is always A-Z0-9 and at most len characters.
export function shorthand(text: string, len = 6): string {
  const plain = text.normalize('NFD').replace(/\p{M}+/gu, '').toUpperCase();
  const words = plain.split(/[^A-Z0-9]+/).filter(Boolean);
  const joined = words.map((w) => w[0] + w.slice(1).replace(VOWELS, '')).join('');
  if (joined.length >= 3) return joined.slice(0, len);
  return plain.replace(/[^A-Z0-9]/g, '').slice(0, len);
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

// Barcode bar widths (1 to 4) from a seed: FNV-1a hash, then an xorshift32 stream.
// The same seed always gives the same bars.
export function barcodeBars(seed: string, count = 36): number[] {
  let x = fnv1a(seed) || 0x9e3779b9;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out.push((x % 4) + 1);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// The date a show sorts by: its start date, else its month, else its year.
function sortKey(e: { startDate?: string; year?: number; month?: number }): string | undefined {
  if (e.startDate) return e.startDate;
  if (e.year !== undefined && e.month !== undefined) return `${e.year}-${pad2(e.month)}-01`;
  if (e.year !== undefined) return `${e.year}-01-01`;
  return undefined;
}

// The event's 1-based place among the events you went to, oldest first.
// Undated shows sort last and get null. Null when the event is not counted.
export function showNumber(
  eventId: string,
  events: Array<{ id: string; startDate?: string; year?: number; month?: number; attendance?: 'planned' | 'missed' }>,
  today: string,
): number | null {
  const went = wentTo(events, today);
  const target = went.find((e) => e.id === eventId);
  if (!target || sortKey(target) === undefined) return null;
  const dated = went
    .filter((e) => sortKey(e) !== undefined)
    .sort((a, b) => {
      const ka = sortKey(a) as string;
      const kb = sortKey(b) as string;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const idx = dated.findIndex((e) => e.id === eventId);
  return idx >= 0 ? idx + 1 : null;
}

export type StubPiece = 'admit' | 'shortDate' | 'barcode' | 'ticketFacts' | 'went' | 'showNumber' | 'shorthand';

// Pieces for the stub end, in fixed order, cut to room. Because the list is
// cut from the front, showNumber and shorthand only appear once every earlier
// piece fits.
export function stubPieces(
  have: { shortDate: boolean; ticketFacts: boolean; went: boolean; showNumber: boolean },
  room: number,
): StubPiece[] {
  const all: StubPiece[] = ['admit'];
  if (have.shortDate) all.push('shortDate');
  all.push('barcode');
  if (have.ticketFacts) all.push('ticketFacts');
  if (have.went) all.push('went');
  if (have.showNumber) all.push('showNumber');
  all.push('shorthand');
  return all.slice(0, Math.max(0, room));
}

// Pieces for a share card. Never admit or ticket facts (private).
export function stubPiecesShared(have: { shortDate: boolean; went: boolean }, room: number): StubPiece[] {
  const all: StubPiece[] = [];
  if (have.went) all.push('went');
  all.push('shorthand', 'barcode');
  if (have.shortDate) all.push('shortDate');
  return all.slice(0, Math.max(0, room));
}

const money = (n: number): string => {
  if (Number.isInteger(n)) return `$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  const [whole, cents] = n.toFixed(2).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
};

// The one plain sentence a screen reader gets for the stub end.
export function stubSentence(p: { admit: number; price?: number; went?: string }): string {
  const parts: string[] = [];
  if (Number.isFinite(p.admit)) parts.push(`Admit ${p.admit}`);
  if (p.price !== undefined && Number.isFinite(p.price)) parts.push(money(p.price));
  if (p.went && p.went.trim() !== '') parts.push(`went ${p.went.trim()}`);
  return parts.length ? `${parts.join(', ')}.` : '';
}
