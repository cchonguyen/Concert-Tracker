import type { Entity, EntityKind, EntityLink } from '../server/entities/types';
import { norm } from './listImport';

// The drift catcher in Manage's Data health (Manage step 5), worked out from
// your records, their links and the IDs saved on your events. Everything
// here is a list of things to look at or a one-tap offer; nothing is changed
// without a tap.

export interface HealthInput {
  entities: Entity[];
  links: EntityLink[];
  events: Array<{ refs?: { venueId: string | null; seriesId: string | null } | null }>;
}

// Kinds that can carry labels.
export const LABELLED: EntityKind[] = ['venue', 'series'];

const liveOf = (input: HealthInput, kind: EntityKind) => input.entities.filter((e) => e.kind === kind && !e.mergedIntoId);
const groupOf = (label: Entity | undefined): string => (label ? String(label.attrs.group ?? '').trim() : '');

// Label IDs on each record.
function labelsOn(input: HealthInput): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of input.links) if (l.role === 'has_label') out.set(l.fromId, [...(out.get(l.fromId) ?? []), l.toId]);
  return out;
}

// Live labels by group (labels without a group are left out).
export function labelGroups(entities: Entity[]): Map<string, Entity[]> {
  const out = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.kind !== 'label' || e.mergedIntoId) continue;
    const g = groupOf(e);
    if (!g) continue;
    const key = norm(g);
    const at = [...out.keys()].find((k) => norm(k) === key) ?? g;
    out.set(at, [...(out.get(at) ?? []), e]);
  }
  return out;
}

// The record's label in this group, if any.
export function labelIn(input: HealthInput, recordId: string, group: string): Entity | undefined {
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  return (labelsOn(input).get(recordId) ?? []).map((id) => byId.get(id)).find((l) => l && norm(groupOf(l)) === norm(group));
}

// A label group used on one record of a kind becomes a field for every
// record of that kind; these are the records still without it.
export interface CategoryGap {
  kind: EntityKind;
  group: string;
  labels: Entity[];
  missing: Entity[];
}

export function categoryGaps(input: HealthInput): CategoryGap[] {
  const groups = labelGroups(input.entities);
  const on = labelsOn(input);
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const out: CategoryGap[] = [];
  for (const kind of LABELLED) {
    const records = liveOf(input, kind);
    for (const [group, labels] of groups) {
      const has = (r: Entity) => (on.get(r.id) ?? []).some((id) => norm(groupOf(byId.get(id))) === norm(group));
      if (!records.some(has)) continue;
      const missing = records.filter((r) => !has(r)).sort((a, b) => a.name.localeCompare(b.name));
      if (missing.length) out.push({ kind, group, labels, missing });
    }
  }
  return out;
}

// One-tap offers across linked records: a series and the venues its events
// were at share a group's label when only one side has it.
export interface LabelSuggestion {
  recordId: string;
  labelId: string;
  becauseId: string; // the record that has the label
}

export function linkedSuggestions(input: HealthInput): LabelSuggestion[] {
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const on = labelsOn(input);
  const pairs = new Set<string>();
  for (const e of input.events) {
    const v = e.refs?.venueId;
    const s = e.refs?.seriesId;
    if (v && s && byId.get(v) && byId.get(s) && !byId.get(v)!.mergedIntoId && !byId.get(s)!.mergedIntoId) pairs.add(`${s}\u0000${v}`);
  }
  const groupsOn = (id: string) => new Map((on.get(id) ?? []).map((l) => [norm(groupOf(byId.get(l))), l] as const).filter(([g]) => g));
  const out = new Map<string, LabelSuggestion>();
  const offer = (from: string, to: string) => {
    const mine = groupsOn(from);
    const theirs = groupsOn(to);
    for (const [g, labelId] of mine) {
      if (theirs.has(g)) continue;
      const k = `${to}\u0000${labelId}`;
      if (!out.has(k)) out.set(k, { recordId: to, labelId, becauseId: from });
    }
  };
  for (const pair of pairs) {
    const [s, v] = pair.split('\u0000');
    offer(s, v);
    offer(v, s);
  }
  return [...out.values()];
}

// Labels on at most one record: often a typo of another, or not needed.
export function rareLabels(input: HealthInput): Array<{ label: Entity; uses: number }> {
  const uses = new Map<string, number>();
  for (const l of input.links) if (l.role === 'has_label') uses.set(l.toId, (uses.get(l.toId) ?? 0) + 1);
  return liveOf(input, 'label')
    .map((label) => ({ label, uses: uses.get(label.id) ?? 0 }))
    .filter((r) => r.uses <= 1)
    .sort((a, b) => a.uses - b.uses || a.label.name.localeCompare(b.label.name));
}

// Venues used on your events that are in no place yet.
export function venuesWithoutPlace(input: HealthInput): Entity[] {
  const placed = new Set(input.links.filter((l) => l.role === 'in').map((l) => l.fromId));
  const used = new Set(input.events.map((e) => e.refs?.venueId).filter(Boolean));
  return liveOf(input, 'venue')
    .filter((v) => used.has(v.id) && !placed.has(v.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Venues where a save brought another city than the venue's place (kept as
// offers when the place replaced it): which one is right is your call.
export function placeOfferVenues(entities: Entity[]): Array<{ venue: Entity; offers: Array<{ city: string; region?: string; country?: string; eventId: string; from: string }> }> {
  return entities
    .filter((e) => e.kind === 'venue' && !e.mergedIntoId && Array.isArray(e.attrs.placeOffers) && (e.attrs.placeOffers as unknown[]).length > 0)
    .map((venue) => ({ venue, offers: venue.attrs.placeOffers as Array<{ city: string; region?: string; country?: string; eventId: string; from: string }> }));
}
