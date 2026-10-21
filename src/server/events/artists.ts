import type { Edition, LookupJob, SourceType } from '../lineup/types';
import { Billing, billingFromTitle, placeInTitle } from '../lineup/billing';
import { normalizeName } from '../lineup/text';
import type { LoggedEvent } from './types';

// "Porter Robinson as Artist?": an act named in the event's own name, offered
// as a one-tap seen act only when a source lists that act for this event (a
// Ticketmaster attraction, the setlist.fm artist, or the lineup). The name is
// your text and the source confirms it is a performer, so nothing is guessed;
// it still takes your tap (REQUIREMENTS.md R3.4).

export interface ArtistSuggestion {
  key: string;
  name: string;
  role?: Billing; // from a marker in the name: "X with special guest Y"
  sourceType: SourceType;
  sourceUrl?: string;
}

interface Performer {
  name: string;
  sourceType: SourceType;
  sourceUrl?: string;
}

// Acts sources list for this event: the stage 1 listing it was matched to,
// the lineup lookup's candidates and the confirmed lineup.
export function eventPerformers(event: LoggedEvent, job?: LookupJob | null, edition?: Edition | null): Performer[] {
  const out: Performer[] = [];
  const confirmed = event.details.status === 'matched' || event.details.status === 'resolved' ? event.details.candidates[0] : undefined;
  out.push(...(confirmed?.performers ?? []));
  for (const p of job?.candidate?.performers ?? []) {
    const src = p.sources.find((s) => s.sourceType !== 'user');
    if (src) out.push({ name: p.name, sourceType: src.sourceType, sourceUrl: src.sourceUrl });
  }
  for (const p of edition?.performances ?? []) {
    const src = p.sources.find((s) => s.sourceType !== 'user');
    if (src && p.status !== 'cancelled') out.push({ name: p.name, sourceType: src.sourceType, sourceUrl: src.sourceUrl });
  }
  return out;
}

export function artistSuggestions(event: LoggedEvent, performers: Performer[]): ArtistSuggestion[] {
  const seen = new Set(event.seen.map((s) => s.key));
  const byKey = new Map<string, Performer>();
  for (const p of performers) {
    const key = normalizeName(p.name);
    if (key && !seen.has(key) && !byKey.has(key)) byKey.set(key, p);
  }
  if (!byKey.size) return [];
  const names = [...byKey.values()].map((p) => p.name);
  // A role needs a marker with a confirmed act on each side of it (acts you
  // already ticked count too).
  const roles = billingFromTitle(event.name, performers.map((p) => p.name));
  return [...placeInTitle(event.name, names).entries()]
    .filter(([, place]) => place !== 'none')
    .map(([key]) => {
      const p = byKey.get(key)!;
      return { key, name: p.name, role: roles.get(key), sourceType: p.sourceType, sourceUrl: p.sourceUrl };
    });
}
