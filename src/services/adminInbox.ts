// Pure helpers for the owner inbox. No personal fields are read or shown.
import type { InboxEdition, InboxItem, InboxTrace } from './lineupApi';

export type InboxKind = InboxItem['kind'];
export const KIND_ORDER: InboxKind[] = ['override', 'merge_suggestion', 'provisional', 'formatting', 'failed_lookup'];
export const KIND_LABELS: Record<InboxKind, string> = {
  override: 'Changes people made',
  merge_suggestion: 'Possible duplicates',
  provisional: 'New editions to check',
  formatting: 'Name and venue tidy-ups',
  failed_lookup: 'Lookups that did not work',
};

export interface InboxGroup { kind: InboxKind; label: string; items: InboxItem[] }

// Open items only, grouped in a fixed order, newest first within a group. Empty groups are left out.
export function groupByKind(items: InboxItem[]): InboxGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    items: items.filter((i) => i.kind === kind && i.status === 'open').sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
  })).filter((g) => g.items.length > 0);
}

const FIELD_LABELS: Record<string, string> = { name: 'Name', startDate: 'Start date', endDate: 'End date', venue: 'Venue', city: 'City', country: 'Country' };
export const fieldLabel = (f: unknown): string => (typeof f === 'string' ? FIELD_LABELS[f] ?? f : 'A field');

const show = (v: unknown): string => (typeof v === 'string' && v.trim() ? v : 'blank');

export function editionLine(e: InboxEdition | null): string {
  if (!e) return 'An edition that no longer exists';
  const when = e.startDate ? (e.endDate && e.endDate !== e.startDate ? `${e.startDate} to ${e.endDate}` : e.startDate) : 'no date';
  return [e.name, when, e.venue || 'no venue'].join(' · ');
}

// The old and new values of an override or formatting row, or null when the row has neither.
export function change(item: InboxItem): { field: string; oldValue: string; newValue: string } | null {
  const p = item.payload ?? {};
  if (!('old' in p) && !('new' in p)) return null;
  return { field: fieldLabel(p.field), oldValue: show(p.old), newValue: show(p.new) };
}

// Ids the owner can pick between in a merge suggestion.
export function mergeChoices(item: InboxItem): string[] {
  const ids = ((item.payload?.editionIds as unknown[]) ?? []).filter((x): x is string => typeof x === 'string');
  if (item.editionId) ids.push(item.editionId);
  return [...new Set(ids)];
}

export function failedReason(item: InboxItem): string {
  const r = item.payload?.reason ?? item.payload?.error ?? item.payload?.message;
  return typeof r === 'string' && r ? r : 'No reason was recorded.';
}

const TRIGGER_LABELS: Record<string, string> = {
  save: 'Event saved',
  research: 'Research',
  research_reader: 'Research with the reader',
  backfill: 'Backfill',
  research_backfill: 'Research backfill',
  lookup: 'Lineup lookup',
};
export const triggerLabel = (t: string): string => TRIGGER_LABELS[t] ?? t;

export function traceSummary(t: InboxTrace): { title: string; target: string; steps: string; requests: string } {
  const names = t.steps.map((s) => s.name);
  return {
    title: triggerLabel(t.trigger),
    target: t.editionId ? 'an edition' : t.eventId ? 'an event' : 'no event or edition',
    steps: names.length ? `${names.length} step${names.length === 1 ? '' : 's'}: ${names.join(', ')}` : 'No steps recorded',
    requests: t.subrequests == null ? 'Requests not counted' : `${t.subrequests} request${t.subrequests === 1 ? '' : 's'}`,
  };
}
