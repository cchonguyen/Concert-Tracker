import type { Edition } from '../lineup/types';
import type { EventKind, LoggedEvent } from './types';

// Concert or festival, worked out from what the event already records. Runs
// in the browser (Table, event view) and on the server, so it imports types
// only. Your choice (LoggedEvent.kind) always wins. Without enough to go on
// the answer is "not known yet", never a default (REQUIREMENTS.md, principle 1).

// More acts than this makes a festival.
export const CONCERT_MAX_ACTS = 5;

// What a confirmed lineup says about the event's size.
export interface LineupFacts {
  acts: number; // acts that were not cancelled
  clashfinder: boolean; // an act came from Clashfinder
}

export interface EventScale {
  kind?: EventKind;
  by: 'you' | 'rule';
  reason: string;
}

export function lineupFacts(edition: Pick<Edition, 'performances'>): LineupFacts {
  const acts = edition.performances.filter((p) => p.status !== 'cancelled');
  return { acts: acts.length, clashfinder: acts.some((p) => p.sources.some((s) => s.sourceType === 'clashfinder')) };
}

const DAY_MS = 86_400_000;

// Stage 1 matched the event's date to a Clashfinder edition.
function onClashfinder(e: LoggedEvent): boolean {
  if (e.details.status !== 'matched' && e.details.status !== 'resolved') return false;
  return Boolean(e.details.candidates[0]?.sources.some((s) => s.sourceType === 'clashfinder' && s.fields.includes('startDate')));
}

export function eventScale(e: LoggedEvent, lineup?: LineupFacts): EventScale {
  if (e.kind) return { kind: e.kind, by: 'you', reason: 'Set by you' };
  if (e.startDate && e.endDate && e.endDate > e.startDate) {
    const days = Math.round((Date.parse(e.endDate) - Date.parse(e.startDate)) / DAY_MS) + 1;
    return { kind: 'festival', by: 'rule', reason: `${days} days` };
  }
  const acts = Math.max(lineup?.acts ?? 0, e.seen.length);
  if (acts > CONCERT_MAX_ACTS) return { kind: 'festival', by: 'rule', reason: `${acts} acts` };
  if (lineup?.clashfinder || onClashfinder(e)) return { kind: 'festival', by: 'rule', reason: 'Listed on Clashfinder' };
  if (lineup && lineup.acts > 0) {
    return { kind: 'concert', by: 'rule', reason: `${lineup.acts} act${lineup.acts === 1 ? '' : 's'} on one day` };
  }
  return { by: 'rule', reason: 'Not known yet' };
}

export const KIND_LABELS: Record<EventKind, string> = { concert: 'Concert', festival: 'Festival' };
