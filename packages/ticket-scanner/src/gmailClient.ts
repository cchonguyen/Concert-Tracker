// Gmail in the browser: list ticket mail with the two stream queries, fetch
// each message with a short-lived token, and read it in memory. Web APIs
// only (fetch, atob); the token never leaves the caller. Nothing is stored.

import { queriesSince, STREAM_A_QUERY, STREAM_B_QUERY } from './queries.ts';
import { scanEmails } from './scan.ts';
import type { EmailImportProposal, RawEmailMessage } from './types.ts';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// How far each stream has read: the newest message's received time.
export interface EmailScanCursors {
  streamA?: string;
  streamB?: string;
}

export interface GmailScanProgress {
  phase: 'listing' | 'reading' | 'done';
  examined: number;
  total: number;
  found: number; // proposals read so far
}

export interface GmailScanOptions {
  token: string;
  cursors?: EmailScanCursors;
  // Read all past mail, as if no cursor were saved (a full re-scan).
  ignoreCursors?: boolean;
  onProgress?: (p: GmailScanProgress) => void;
  maxMessages?: number;
  concurrency?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

// What a host needs to show and store messages without the bodies.
export interface ScannedMessage {
  id: string;
  link: string;
  from: string;
  subject: string;
  sentAt: string;
  stream: 'A' | 'B';
}

export interface GmailScanResult {
  proposals: EmailImportProposal[];
  messages: ScannedMessage[];
  updatedCursors: EmailScanCursors;
  examined: number;
  failed: string[]; // ids Gmail would not hand over
  failureReason?: string; // Gmail's answer for the last one refused
  summary: ScanSummary;
}

export class GmailTokenError extends Error {}

export async function scanGmailInBrowser(options: GmailScanOptions): Promise<GmailScanResult> {
  const doFetch = options.fetch ?? fetch;
  const cursors = options.ignoreCursors ? {} : (options.cursors ?? {});
  const progress = (p: GmailScanProgress) => options.onProgress?.(p);

  const get = async (url: string): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${options.token}` }, signal: options.signal });
      if (res.ok) return res.json();
      if (res.status === 401) throw new GmailTokenError('The Google sign-in expired. Sign in again.');
      // Gmail says "slow down" with 429, or with 403 and a rateLimitExceeded reason.
      const body = res.status === 403 ? await res.text().catch(() => '') : '';
      const slowDown = res.status === 429 || res.status >= 500 || /rate ?limit|quota/i.test(body);
      if (slowDown && attempt < 6) {
        await new Promise((r) => setTimeout(r, Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 500));
        continue;
      }
      throw new Error(`Gmail answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
  };

  progress({ phase: 'listing', examined: 0, total: 0, found: 0 });
  const streamOf = new Map<string, 'A' | 'B'>();
  const list = async (query: string, stream: 'A' | 'B') => {
    let pageToken = '';
    do {
      const page = await get(`${API}/messages?maxResults=500&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const m of page.messages ?? []) if (!streamOf.has(m.id)) streamOf.set(m.id, stream);
      pageToken = page.nextPageToken ?? '';
    } while (pageToken && (!options.maxMessages || streamOf.size < options.maxMessages));
  };
  await list(cursors.streamA ? queriesSince(cursors.streamA).streamA : STREAM_A_QUERY, 'A');
  await list(cursors.streamB ? queriesSince(cursors.streamB).streamB : STREAM_B_QUERY, 'B');
  const ids = [...streamOf.keys()].slice(0, options.maxMessages || undefined);

  const raws: RawEmailMessage[] = [];
  const messages: ScannedMessage[] = [];
  const failed: string[] = [];
  let found = 0;
  let next = 0;
  let lastError: string | undefined;
  const read = async (id: string, queue: string[]) => {
    try {
      const raw = await fetchMessage(get, id);
      raws.push(raw);
      messages.push({ id, link: raw.link, from: raw.from, subject: raw.subject, sentAt: raw.sentAt, stream: streamOf.get(id)! });
      found += (await scanEmails([raw])).filter((p) => p.status !== 'unreadable').length;
    } catch (err) {
      if (err instanceof GmailTokenError || options.signal?.aborted) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      queue.push(id);
    }
  };
  const retry: string[] = [];
  const worker = async () => {
    while (next < ids.length) {
      await read(ids[next++], retry);
      progress({ phase: 'reading', examined: raws.length + retry.length, total: ids.length, found });
    }
  };
  // Gmail allows a user about 50 message reads a second; two at a time stays well under.
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
  // What Gmail refused is tried once more, one at a time, after a pause.
  if (retry.length) await new Promise((r) => setTimeout(r, 5000));
  for (const id of retry) {
    await read(id, failed);
    progress({ phase: 'reading', examined: raws.length + failed.length, total: ids.length, found });
  }

  // Grouping needs every message at once (receipt + tickets + refund).
  raws.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const proposals = await scanEmails(raws);
  const updatedCursors: EmailScanCursors = { ...cursors };
  for (const m of messages) {
    const key = m.stream === 'A' ? 'streamA' : 'streamB';
    if (!updatedCursors[key] || m.sentAt > updatedCursors[key]!) updatedCursors[key] = m.sentAt;
  }
  const summary = summarizeScan(proposals, messages, failed.length);
  progress({ phase: 'done', examined: messages.length + failed.length, total: ids.length, found: summary.proposals });
  return { proposals, messages, updatedCursors, examined: messages.length, failed, failureReason: failed.length ? lastError : undefined, summary };
}

async function fetchMessage(get: (url: string) => Promise<any>, id: string): Promise<RawEmailMessage> {
  const msg = await get(`${API}/messages/${id}?format=full`);
  const headers: Array<{ name: string; value: string }> = msg.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const raw: RawEmailMessage = {
    id,
    threadId: msg.threadId,
    link: `https://mail.google.com/mail/u/0/#all/${id}`,
    from: header('from'),
    to: header('to') || undefined,
    subject: header('subject'),
    sentAt: new Date(Number(msg.internalDate) || Date.parse(header('date')) || 0).toISOString(),
    attachments: [],
  };
  const walk = async (part: any): Promise<void> => {
    const filename: string = part.filename ?? '';
    const mime: string = part.mimeType ?? '';
    if (filename && /\.(pkpass|ics)$/i.test(filename)) {
      const data = part.body?.data ?? (part.body?.attachmentId ? (await get(`${API}/messages/${id}/attachments/${part.body.attachmentId}`)).data : undefined);
      if (data) raw.attachments!.push({ filename, mimeType: mime, dataBase64: fromUrlSafe(data) });
    } else if (!filename && part.body?.data && (mime === 'text/html' || mime === 'text/plain')) {
      const text = decodeBase64Url(part.body.data);
      if (mime === 'text/html') raw.html ??= text;
      else raw.text ??= text;
    } else if (mime === 'text/calendar' && part.body?.data) {
      raw.attachments!.push({ filename: 'invite.ics', mimeType: mime, dataBase64: fromUrlSafe(part.body.data) });
    }
    for (const child of part.parts ?? []) await walk(child);
  };
  if (msg.payload) await walk(msg.payload);
  return raw;
}

const fromUrlSafe = (data: string) => data.replace(/-/g, '+').replace(/_/g, '/');

export function decodeBase64Url(data: string): string {
  const bin = atob(fromUrlSafe(data));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// The diagnostic report for a scan: counts only, read from the proposals.
export interface ScanSummary {
  examined: number;
  failed: number;
  proposals: number; // shows found (status new)
  bySeller: Record<string, number>;
  unreadable: Array<{ subject: string; links: string[] }>;
  flagged: number; // refunded, cancelled or transferred
  netUniqueEvents: number; // distinct name + date among shows found
}

export function summarizeScan(proposals: EmailImportProposal[], messages: Array<{ id: string }>, failed = 0): ScanSummary {
  const shows = proposals.filter((p) => p.status === 'new');
  const bySeller: Record<string, number> = {};
  for (const p of shows) {
    const seller = p.seller.replace(/^forwarded:/, '');
    bySeller[seller] = (bySeller[seller] ?? 0) + 1;
  }
  const unique = new Set(shows.map((p) => `${(p.name?.value ?? '').toLowerCase().trim()}|${p.date?.value ?? p.orderNumber ?? p.key}`));
  return {
    examined: messages.length,
    failed,
    proposals: shows.length,
    bySeller,
    unreadable: proposals.filter((p) => p.status === 'unreadable').map((p) => ({ subject: p.rawSubject ?? '(no subject)', links: p.messageLinks })),
    flagged: proposals.filter((p) => p.status === 'flag' || p.flags.length > 0).length,
    netUniqueEvents: unique.size,
  };
}

// One row per proposal, for auditing a scan by hand: what was read, from
// which email, and the words it was read from.
export function scanReportCsv(proposals: EmailImportProposal[], messages: ScannedMessage[]): string {
  const byLink = new Map(messages.map((m) => [m.link, m]));
  const cell = (v: unknown) => {
    const t = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ['status', 'seller', 'name', 'date', 'venue', 'city', 'ticket_price', 'flags', 'read_by', 'name_quote', 'subject', 'from', 'sent_at', 'emails', 'link'];
  const rows = proposals.map((p) => {
    const first = byLink.get(p.messageLinks[0]);
    return [
      p.status,
      p.seller,
      p.name?.value,
      p.date?.value,
      p.venue?.value,
      p.city?.value,
      p.ticketPrice?.amount,
      p.flags.map((f) => f.kind).join(' '),
      p.name?.readBy,
      p.name?.quote,
      first?.subject ?? p.rawSubject,
      first?.from,
      first?.sentAt,
      p.messageLinks.length,
      p.messageLinks[0],
    ]
      .map(cell)
      .join(',');
  });
  return [head.join(','), ...rows].join('\n') + '\n';
}
