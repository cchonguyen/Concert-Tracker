import type { LineupStore } from '../../lineup/store/types';
import type { GmailApi } from './gmail';
import { mergeImports, READERS, readEmails } from './imports';

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

export interface ScanSetting {
  scannedThrough?: string; // newest message read so far (Gmail's received time)
  lastCheckedAt?: string; // when a check last finished
  // Messages read within a day of scannedThrough. The search looks back a
  // day so mail that arrives late is not missed; these are not read twice.
  recent: Record<string, string>;
}

export interface ScanStep {
  read: number; // messages read in this call
  remaining: number; // still to read; call again while above 0
  added: number; // shows new to the review list
  scannedThrough?: string;
  lastCheckedAt?: string;
}

export class NotConnected extends Error {}

export const senderQuery = () => `from:(${READERS.map((r) => r.domain).join(' OR ')})`;

// Before the first check, the newest email already on the review list
// (the Gmail back-fill) marks how far your mail has been read.
function startingPoint(rows: Awaited<ReturnType<LineupStore['listImports']>>): ScanSetting {
  const times = rows.flatMap((r) => r.messages.map((m) => Date.parse(m.sentAt))).filter((t) => !Number.isNaN(t));
  return { scannedThrough: times.length ? new Date(Math.max(...times)).toISOString() : undefined, recent: {} };
}

export async function scanStep(store: LineupStore, gmail: GmailApi, now: Date, batch = SCAN_BATCH): Promise<ScanStep> {
  const login = await store.getSetting<GmailSetting>(GMAIL_SETTING);
  if (!login) throw new NotConnected('Connect Gmail first.');
  const [existing, events, saved] = await Promise.all([store.listImports(), store.listEvents(), store.getSetting<ScanSetting>(SCAN_SETTING)]);
  const state = saved ?? startingPoint(existing);

  const since = state.scannedThrough ? Math.floor((Date.parse(state.scannedThrough) - DAY_MS) / 1000) : undefined;
  const query = since ? `${senderQuery()} after:${since}` : senderQuery();
  const known = new Set([...existing.flatMap((r) => r.messages.map((m) => m.id)), ...Object.keys(state.recent)]);
  // Gmail lists newest first; read the oldest first so a check that stops
  // halfway picks up where it left off.
  const todo = (await gmail.listIds(login.refreshToken, query)).filter((id) => !known.has(id)).reverse();
  const messages = await Promise.all(todo.slice(0, batch).map((id) => gmail.getMessage(login.refreshToken, id)));

  const changed = mergeImports(existing, readEmails(messages).outcomes, events, now);
  await store.putImports(changed);
  const before = new Set(existing.map((r) => r.id));

  for (const m of messages) {
    state.recent[m.id] = m.sentAt;
    if (!state.scannedThrough || Date.parse(m.sentAt) > Date.parse(state.scannedThrough)) state.scannedThrough = new Date(m.sentAt).toISOString();
  }
  const cutoff = state.scannedThrough ? Date.parse(state.scannedThrough) - DAY_MS : 0;
  state.recent = Object.fromEntries(Object.entries(state.recent).filter(([, at]) => Date.parse(at) >= cutoff));
  const remaining = todo.length - messages.length;
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
