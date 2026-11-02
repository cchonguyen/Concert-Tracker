import { randomUUID } from 'node:crypto';
import type { LineupStore } from '../lineup/store/types';
import type { HistoryEntry } from './types';
import { normalizeName } from '../lineup/text';
import { readActName } from '../lineup/actName';
import { findPerformanceGroups } from '../events/seen';
import type { LoggedEvent, SeenAct } from '../events/types';

export interface CollaborationRecord {
  alias: string;
  aliasNormalized: string;
  canonicalName: string;
  partners: string[];
}

export async function listCollaborations(store: LineupStore): Promise<CollaborationRecord[]> {
  const aliases = await store.getAliases();
  const out: CollaborationRecord[] = [];
  const events = await store.listEvents();

  // Find exact display casing from events if available
  const casingMap = new Map<string, string>();
  for (const e of events) {
    for (const s of e.seen) {
      if (s.alias) casingMap.set(normalizeName(s.alias), s.alias);
    }
  }

  for (const [normAlias, canonical] of Object.entries(aliases)) {
    const read = readActName(canonical);
    if (read.parts.length > 1) {
      const displayAlias = casingMap.get(normAlias) ?? normAlias;
      out.push({
        alias: displayAlias,
        aliasNormalized: normAlias,
        canonicalName: canonical,
        partners: read.parts,
      });
    }
  }

  return out.sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function saveCollaboration(
  store: LineupStore,
  params: { alias: string; partners: string[]; oldAlias?: string },
): Promise<{ record: CollaborationRecord; entry: HistoryEntry }> {
  const alias = params.alias.trim();
  const partners = params.partners.map((p) => p.trim()).filter(Boolean);
  if (!alias) throw new Error('Alias moniker name is required.');
  if (partners.length < 2) throw new Error('At least two partners are required for a collaboration.');

  const aliasNormalized = normalizeName(alias);
  const canonicalName = partners.join(' b2b ');
  const partnerKeys = new Set(partners.map((p) => normalizeName(p)));

  // 1. Update alias registry
  const oldNorm = params.oldAlias ? normalizeName(params.oldAlias) : undefined;
  if (oldNorm && oldNorm !== aliasNormalized) {
    await store.deleteAlias(oldNorm);
  }
  await store.putAliases({ [aliasNormalized]: canonicalName });

  // 2. Scan events and propagate alias to matching B2B groups
  const events = await store.listEvents();
  const eventDiffs: HistoryEntry['events'] = [];
  const updatedEvents: LoggedEvent[] = [];

  for (const event of events) {
    if (!event.seen || !event.seen.length) continue;
    let changed = false;
    const oldSeen = [...event.seen];

    // Find B2B groups in seen acts
    const groups: number[][] = findPerformanceGroups<SeenAct>(
      event.seen,
      (s: SeenAct) => s.key,
      (s: SeenAct) => s.b2b,
      (s: SeenAct) => s.slotId,
    );

    const nextSeen: SeenAct[] = event.seen.map((act) => ({ ...act }));

    for (const groupIndices of groups) {
      const groupKeys = new Set<string>(groupIndices.map((i: number) => event.seen[i].key));
      const isMatch =
        groupKeys.size === partnerKeys.size && [...groupKeys].every((k: string) => partnerKeys.has(k));
      const hadOldAlias =
        Boolean(oldNorm && groupIndices.some((i: number) => event.seen[i].alias && normalizeName(event.seen[i].alias!) === oldNorm));

      if (isMatch || hadOldAlias) {
        for (const idx of groupIndices) {
          if (nextSeen[idx].alias !== alias) {
            nextSeen[idx].alias = alias;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      eventDiffs.push({
        id: event.id,
        before: { seen: oldSeen },
        after: { seen: nextSeen },
      });
      updatedEvents.push({ ...event, seen: nextSeen });
    }
  }

  if (updatedEvents.length) {
    await store.putEvents(updatedEvents);
  }

  const at = new Date().toISOString();
  const entry: HistoryEntry = {
    id: randomUUID(),
    operation: 'alias-add',
    summary: `Saved collaboration "${alias}" (${partners.join(', ')})`,
    sourceEntityId: '',
    entities: { before: [], after: [] },
    touched: [],
    aliases: { before: [], after: [] },
    links: { before: [], after: [] },
    events: eventDiffs,
    createdAt: at,
  };

  try {
    await store.putEntityHistory(entry);
  } catch {
    // If linking/entity store history not enabled, silently proceed
  }

  const record: CollaborationRecord = {
    alias,
    aliasNormalized,
    canonicalName,
    partners,
  };

  return { record, entry };
}

export async function removeCollaboration(
  store: LineupStore,
  alias: string,
): Promise<{ entry: HistoryEntry }> {
  const normAlias = normalizeName(alias);
  await store.deleteAlias(normAlias);

  const events = await store.listEvents();
  const eventDiffs: HistoryEntry['events'] = [];
  const updatedEvents: LoggedEvent[] = [];

  for (const event of events) {
    if (!event.seen || !event.seen.length) continue;
    let changed = false;
    const oldSeen = [...event.seen];

    const nextSeen = event.seen.map((act) => {
      if (act.alias && normalizeName(act.alias) === normAlias) {
        changed = true;
        const { alias: _a, ...rest } = act;
        return rest as SeenAct;
      }
      return act;
    });

    if (changed) {
      eventDiffs.push({
        id: event.id,
        before: { seen: oldSeen },
        after: { seen: nextSeen },
      });
      updatedEvents.push({ ...event, seen: nextSeen });
    }
  }

  if (updatedEvents.length) {
    await store.putEvents(updatedEvents);
  }

  const at = new Date().toISOString();
  const entry: HistoryEntry = {
    id: randomUUID(),
    operation: 'alias-remove',
    summary: `Removed collaboration "${alias}"`,
    sourceEntityId: '',
    entities: { before: [], after: [] },
    touched: [],
    aliases: { before: [], after: [] },
    links: { before: [], after: [] },
    events: eventDiffs,
    createdAt: at,
  };

  try {
    await store.putEntityHistory(entry);
  } catch {
    // Ignore if entity history table not available
  }

  return { entry };
}
