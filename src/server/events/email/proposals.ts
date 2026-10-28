import { randomUUID } from 'node:crypto';
import type { EmailImportProposal, EmailScanCursors, FieldEvidence, ScannedMessage } from '@livearchive/ticket-scanner';
import { normalizeName } from '../../lineup/text';
import type { LoggedEvent } from '../types';
import { findLogged } from './imports';
import type { EmailImport, ImportFlag } from './types';

// Proposals from the browser scan (@livearchive/ticket-scanner) folded into
// the review list. Same rule as every import: a value fills only a field the
// row does not have yet, and your ticks (added, skipped) are never undone.

export const BROWSER_SCAN_SETTING = 'email_scan_browser';

export interface BrowserScanSetting extends EmailScanCursors {
  savedAt?: string;
}

const FLAGS: Record<EmailImportProposal['flags'][number]['kind'], ImportFlag> = {
  refunded: 'refunded',
  cancelled: 'cancelled',
  transferred: 'transferred_away',
};

const idOfLink = (link: string) => link.split(/[/#]/).pop() ?? link;

function keyOf(p: EmailImportProposal, firstId: string): string {
  if (p.status === 'unreadable') return `unreadable|${firstId}`;
  const name = p.name ? normalizeName(p.name.value) : '';
  if (p.status === 'flag') return `flag|${normalizeName(p.seller)}|${name}`;
  if (name && p.date) return `${name}|${p.date.value}`;
  if (p.orderNumber) return `${normalizeName(p.seller)}|order|${p.orderNumber}`;
  return p.key;
}

export function mergeProposals(
  existing: EmailImport[],
  proposals: EmailImportProposal[],
  scanned: ScannedMessage[],
  events: LoggedEvent[],
  now: Date,
): EmailImport[] {
  const iso = now.toISOString();
  const meta = new Map(scanned.map((m) => [m.link, m]));
  const rows = [...existing];
  const changed = new Set<EmailImport>();

  for (const p of proposals) {
    const messages = p.messageLinks.map((link) => {
      const m = meta.get(link);
      return { id: m?.id ?? idOfLink(link), link, subject: m?.subject ?? p.rawSubject ?? p.name?.value ?? '', sentAt: m?.sentAt ?? iso };
    });
    if (!messages.length) continue;
    const key = keyOf(p, messages[0].id);
    const ids = new Set(messages.map((m) => m.id));
    let row = rows.find((r) => r.key === key) ?? rows.find((r) => r.status !== 'flag' && r.messages.some((m) => ids.has(m.id)));
    let touched = false;
    if (!row) {
      row = { id: randomUUID(), key, status: p.status, seller: p.seller, sources: {}, messages: [], flags: [], createdAt: iso, updatedAt: iso };
      if (p.status === 'unreadable') row.name = p.rawSubject;
      rows.push(row);
      touched = true;
    } else if (row.status === 'unreadable' && p.status === 'new') {
      // The new reader understood an email the old one could not.
      row.status = 'new';
      row.name = undefined;
      touched = true;
    }
    for (const m of messages) {
      if (row.messages.some((x) => x.id === m.id)) continue;
      row.messages.push(m);
      touched = true;
    }
    if (p.status !== 'unreadable') {
      const set = (field: 'name' | 'startDate' | 'endDate' | 'venue' | 'city', ev: FieldEvidence | undefined) => {
        if (!ev || row![field]) return;
        row![field] = ev.value;
        row!.sources[field] = { messageId: ev.messageId, link: ev.messageLink, quote: ev.quote };
        touched = true;
      };
      set('name', p.name);
      set('startDate', p.date);
      set('endDate', p.endDate);
      set('venue', p.venue);
      set('city', p.city);
      if (p.orderNumber && !row.orderIds?.includes(p.orderNumber)) {
        row.orderIds = [...(row.orderIds ?? []), p.orderNumber];
        touched = true;
      }
      if (p.ticketPrice && row.ticketPrice === undefined) {
        row.ticketPrice = p.ticketPrice.amount;
        row.tickets ??= p.ticketPrice.count;
        row.total ??= `$${p.ticketPrice.total.toFixed(2)}`;
        row.sources.ticketPrice = { messageId: idOfLink(p.ticketPrice.messageLink), link: p.ticketPrice.messageLink, quote: p.ticketPrice.quote };
        touched = true;
      }
    }
    for (const f of p.flags) {
      const flag = FLAGS[f.kind];
      if (row.flags.includes(flag)) continue;
      row.flags.push(flag);
      touched = true;
    }
    if (row.status === 'new' && !row.eventId) {
      const logged = findLogged(row, events);
      if (logged) {
        row.eventId = logged.id;
        touched = true;
      }
    }
    if (touched) {
      row.updatedAt = iso;
      changed.add(row);
    }
  }
  return [...changed];
}
