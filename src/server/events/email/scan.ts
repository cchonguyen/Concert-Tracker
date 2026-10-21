import type { LineupStore } from '../../lineup/store/types';
import type { GmailApi } from './gmail';
import { fillPrice, mergeImports, pricesFromImports, READERS, readEmails } from './imports';
import type { EmailImport } from './types';

// "Check email": read the ticket mail that arrived since the last check,
// a few messages per call so each request stays short (the Workers CPU
// limit); the page calls again until nothing is left. New shows land on
// the review list unticked, like any other import.

export const GMAIL_SETTING = 'gmail';
export const SCAN_SETTING = 'email_scan';
export const SCAN_BATCH = 4;
const DAY_MS = 864e5;

export interface GmailSetting {
  refreshToken: string;
  account?: string;
  connectedAt: string;
}

// How far one search has read.
export interface ScanCursor {
  scannedThrough?: string; // newest message read so far (Gmail's received time)
  // Messages read within a day of scannedThrough. The search looks back a
  // day so mail that arrives late is not missed; these are not read twice.
  recent: Record<string, string>;
}

// One cursor per seller (`sellers`, by domain), so a seller whose reader
// was just added is searched through all your past mail once, plus
// `forwards`: mail someone forwarded to you. `scannedThrough` and `recent`
// at the top are how far the first checks read every seller at once; a
// seller that already has rows on the review list starts from there.
export interface ScanSetting extends ScanCursor {
  lastCheckedAt?: string; // when a check last finished
  sellers?: Record<string, ScanCursor>;
  forwards?: ScanCursor;
  // Order emails read before ticket prices were, read once more for their
  // price only: the ids done so far, until every one has been.
  prices?: { done?: boolean; read: string[] };
}

export interface ScanStep {
  read: number; // messages read in this call
  remaining: number; // still to read; call again while above 0
  added: number; // shows new to the review list
  scannedThrough?: string;
  lastCheckedAt?: string;
}

export class NotConnected extends Error {}

const domains = () => READERS.map((r) => r.domain).join(' OR ');
// A seller's own mail; `search` narrows it to its ticket mail when the
// seller also sends a lot of ads.
export const sellerQuery = (reader: (typeof READERS)[number]) => `from:(${reader.domain})${reader.search ? ` ${reader.search}` : ''}`;
// A forward keeps the seller's address in its header ("From: Tixr
// <no-reply@tixr.com>"), so Gmail finds it by that word. Your own forwards
// to others are left out.
export const forwardQuery = () => `subject:(fwd OR fw) -from:me (${domains()})`;

// Before the first check, the newest email already on the review list
// (the Gmail back-fill) marks how far your mail has been read.
function startingPoint(rows: Awaited<ReturnType<LineupStore['listImports']>>): ScanSetting {
  const times = rows.flatMap((r) => r.messages.map((m) => Date.parse(m.sentAt))).filter((t) => !Number.isNaN(t));
  return { scannedThrough: times.length ? new Date(Math.max(...times)).toISOString() : undefined, recent: {} };
}

const since = (query: string, cursor: ScanCursor) =>
  cursor.scannedThrough ? `${query} after:${Math.floor((Date.parse(cursor.scannedThrough) - DAY_MS) / 1000)}` : query;

export async function scanStep(store: LineupStore, gmail: GmailApi, now: Date, batch = SCAN_BATCH): Promise<ScanStep> {
  const login = await store.getSetting<GmailSetting>(GMAIL_SETTING);
  if (!login) throw new NotConnected('Connect Gmail first.');
  const [existing, events, saved] = await Promise.all([store.listImports(), store.listEvents(), store.getSetting<ScanSetting>(SCAN_SETTING)]);
  const state = saved ?? startingPoint(existing);
  state.forwards ??= { recent: {} };
  state.sellers ??= {};
  const sellersWithRows = new Set(existing.map((r) => r.seller));
  const searches: Array<[string, ScanCursor]> = READERS.map((reader) => {
    const cursor = (state.sellers![reader.domain] ??= sellersWithRows.has(reader.seller)
      ? { scannedThrough: state.scannedThrough, recent: { ...state.recent } }
      : { recent: {} });
    return [sellerQuery(reader), cursor];
  });
  searches.push([forwardQuery(), state.forwards]);
  const cursors = searches.map(([, c]) => c);

  // Gmail lists newest first; each search is read oldest first so a check
  // that stops halfway picks up where it left off, one search at a time.
  const known = new Set(existing.flatMap((r) => r.messages.map((m) => m.id)));
  const todos: Array<[ScanCursor, string[]]> = [];
  for (const [query, cursor] of searches) {
    const ids = (await gmail.listIds(login.refreshToken, since(query, cursor)))
      .filter((id) => !known.has(id) && !cursors.some((c) => id in c.recent))
      .reverse();
    ids.forEach((id) => known.add(id));
    todos.push([cursor, ids]);
  }
  // Then, once, the orders already on the list that have no price.
  state.prices ??= { read: [] };
  const reread = new Set(state.prices.read);
  const unpriced = state.prices.done
    ? []
    : existing
        .filter((r) => (r.status === 'new' || r.status === 'added') && r.ticketPrice === undefined)
        .flatMap((r) => r.messages.filter((m) => m.kind === 'order' && !reread.has(m.id)).map((m) => m.id));
  const found = todos.find(([, ids]) => ids.length);
  const [cursor, todo] = found ?? [undefined, unpriced];
  const messages = await Promise.all(todo.slice(0, batch).map((id) => gmail.getMessage(login.refreshToken, id)));

  const changed = cursor ? mergeImports(existing, readEmails(messages).outcomes, events, now) : rereadPrices(existing, messages);
  await store.putImports(changed);
  // Shows in your log without a price take the one their emails give.
  const rows = [...new Map([...existing, ...changed].map((r) => [r.id, r])).values()];
  await store.putEvents(pricesFromImports(rows, events, now));
  const before = new Set(existing.map((r) => r.id));

  if (!cursor) {
    state.prices.read.push(...messages.map((m) => m.id));
    if (messages.length >= unpriced.length) state.prices = { done: true, read: [] };
  } else {
    for (const m of messages) {
      cursor.recent[m.id] = m.sentAt;
      if (!cursor.scannedThrough || Date.parse(m.sentAt) > Date.parse(cursor.scannedThrough)) cursor.scannedThrough = new Date(m.sentAt).toISOString();
    }
    const cutoff = cursor.scannedThrough ? Date.parse(cursor.scannedThrough) - DAY_MS : 0;
    cursor.recent = Object.fromEntries(Object.entries(cursor.recent).filter(([, at]) => Date.parse(at) >= cutoff));
  }
  // How far your mail has been read, for the page: the furthest any search got.
  const furthest = cursors.map((c) => c.scannedThrough).filter((t): t is string => Boolean(t)).sort().pop();
  if (furthest && (!state.scannedThrough || furthest > state.scannedThrough)) state.scannedThrough = furthest;
  const remaining = todos.reduce((n, [, ids]) => n + ids.length, 0) + unpriced.length - messages.length;
  if (!remaining) state.lastCheckedAt = now.toISOString();
  await store.putSetting(SCAN_SETTING, state);

  return {
    read: messages.length,
    remaining,
    added: changed.filter((r) => !before.has(r.id) && r.status === 'new').length,
    scannedThrough: state.scannedThrough,
    lastCheckedAt: state.lastCheckedAt,
  };
}

// The price from an email already on a row, filled into that row only.
function rereadPrices(rows: EmailImport[], messages: Awaited<ReturnType<GmailApi['getMessage']>>[]): EmailImport[] {
  const changed = new Set<EmailImport>();
  for (const o of readEmails(messages).outcomes) {
    if (!('read' in o)) continue;
    const row = rows.find((r) => r.messages.some((m) => m.id === o.email.id));
    if (row && fillPrice(row, o.read, o.email)) changed.add(row);
  }
  return [...changed];
}
