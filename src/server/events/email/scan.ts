import type { LineupStore } from '../../lineup/store/types';
import { listResolvedEvents } from '../inherit';
import { GmailApi, GmailReadError } from './gmail';
import { fillPrice, mergeImports, pricesFromImports, READERS, readEmails } from './imports';
import type { EmailImport } from './types';

// "Check email": read the ticket mail that arrived since the last check,
// a few messages per call so each request stays short (the Workers CPU
// limit); the page calls again until nothing is left. New shows land on
// the review list unticked, like any other import.

export const GMAIL_SETTING = 'gmail';
export const SCAN_SETTING = 'email_scan';
export const SCAN_BATCH = 4;
const QUEUE_MS = 30 * 60 * 1000; // an unfinished check searches again after this
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
  // What this check still has to read, per search (a seller's domain,
  // "forwards" or "prices"), from one round of Gmail searches.
  queue?: Array<{ search: string; listedAt: string; ids: string[] }>;
}

export interface ScanStep {
  read: number; // messages read in this call
  skipped: number; // messages Gmail would not hand over
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
  const [existing, events, saved] = await Promise.all([store.listImports(), listResolvedEvents(store), store.getSetting<ScanSetting>(SCAN_SETTING)]);
  const state = saved ?? startingPoint(existing);
  state.forwards ??= { recent: {} };
  state.sellers ??= {};
  const sellersWithRows = new Set(existing.map((r) => r.seller));
  for (const reader of READERS) {
    state.sellers[reader.domain] ??= sellersWithRows.has(reader.seller)
      ? { scannedThrough: state.scannedThrough, recent: { ...state.recent } }
      : { recent: {} };
  }
  const cursorOf = (search: string): ScanCursor | undefined => (search === 'forwards' ? state.forwards : state.sellers![search]);
  const cursors = [...Object.values(state.sellers), state.forwards];

  // Gmail is searched once per check: what is left to read is kept between
  // calls, so each call only reads a few messages (Gmail limits how fast an
  // app may ask). A check left unfinished for a while searches again.
  state.prices ??= { read: [] };
  if (!state.queue?.some((t) => t.ids.length) || now.getTime() - Date.parse(state.queue[0]?.listedAt ?? '') > QUEUE_MS) {
    state.queue = await search(gmail, login.refreshToken, state, existing, now);
  }
  const todo = state.queue.find((t) => t.ids.length);
  const cursor = todo && todo.search !== 'prices' ? cursorOf(todo.search) : undefined;
  const ids = todo ? todo.ids.slice(0, batch) : [];
  // A message Google will not hand over (deleted since it was listed, say)
  // is skipped and counted, so one bad message does not stop the check.
  const fetched = await Promise.allSettled(ids.map((id) => gmail.getMessage(login.refreshToken, id)));
  const failure = fetched.find((r): r is PromiseRejectedResult => r.status === 'rejected' && !(r.reason instanceof GmailReadError));
  if (failure) throw failure.reason;
  const messages = fetched.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const skipped = ids.length - messages.length;
  if (todo) todo.ids = todo.ids.slice(ids.length);

  const changed = cursor ? mergeImports(existing, readEmails(messages).outcomes, events, now) : rereadPrices(existing, messages);
  await store.putImports(changed);
  // Shows in your log without a price take the one their emails give.
  const rows = [...new Map([...existing, ...changed].map((r) => [r.id, r])).values()];
  await store.putEvents(pricesFromImports(rows, events, now));
  const before = new Set(existing.map((r) => r.id));

  if (todo?.search === 'prices') {
    state.prices.read.push(...ids);
    if (!todo.ids.length) state.prices = { done: true, read: [] };
  } else if (cursor) {
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
  const remaining = state.queue.reduce((n, t) => n + t.ids.length, 0);
  if (!remaining) {
    state.lastCheckedAt = now.toISOString();
    state.queue = [];
  }
  await store.putSetting(SCAN_SETTING, state);

  return {
    read: messages.length,
    skipped,
    remaining,
    added: changed.filter((r) => !before.has(r.id) && r.status === 'new').length,
    scannedThrough: state.scannedThrough,
    lastCheckedAt: state.lastCheckedAt,
  };
}

// Every search, oldest message first (Gmail lists newest first), so a
// check that stops halfway picks up where it left off; then, once, the
// orders already on the list that have no price.
async function search(
  gmail: GmailApi,
  refreshToken: string,
  state: ScanSetting,
  existing: EmailImport[],
  now: Date,
): Promise<NonNullable<ScanSetting['queue']>> {
  const listedAt = now.toISOString();
  const searches: Array<[string, string, ScanCursor]> = READERS.map((r) => [r.domain, sellerQuery(r), state.sellers![r.domain]]);
  searches.push(['forwards', forwardQuery(), state.forwards!]);
  const known = new Set(existing.flatMap((r) => r.messages.map((m) => m.id)));
  const queue: NonNullable<ScanSetting['queue']> = [];
  for (const [key, query, cursor] of searches) {
    const ids = (await gmail.listIds(refreshToken, since(query, cursor)))
      .filter((id) => !known.has(id) && !searches.some(([, , c]) => id in c.recent))
      .reverse();
    ids.forEach((id) => known.add(id));
    queue.push({ search: key, listedAt, ids });
  }
  if (!state.prices?.done) {
    const reread = new Set(state.prices?.read ?? []);
    const ids = existing
      .filter((r) => (r.status === 'new' || r.status === 'added') && r.ticketPrice === undefined)
      .flatMap((r) => r.messages.filter((m) => m.kind === 'order' && !reread.has(m.id)).map((m) => m.id));
    queue.push({ search: 'prices', listedAt, ids });
    if (!ids.length) state.prices = { done: true, read: [] };
  }
  return queue;
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
