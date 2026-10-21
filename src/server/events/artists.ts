import type { Edition, Fetcher, LookupJob, SourceType } from '../lineup/types';
import { Billing, billingFromTitle, placeInTitle, splitBill } from '../lineup/billing';
import { artistNamed } from '../lineup/musicbrainz';
import { normalizeName } from '../lineup/text';
import type { LoggedEvent } from './types';

// "Porter Robinson as Artist?": an act named in the event's own name, offered
// as a one-tap seen act only when a source lists that act for this event (a
// Ticketmaster attraction, the setlist.fm artist, or the lineup). The name is
// your text and the source confirms it is a performer, so nothing is guessed;
// it still takes your tap (REQUIREMENTS.md R3.4). Two more confirmations,
// both still a tap: an act you saw at another event, and a part of the name
// that MusicBrainz knows as an artist (nameArtistSuggestions).

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

// Acts you saw at your other events: if one is named in this event's name,
// it is offered too. Short names are left out, so a word like "Live" in a
// title never matches.
export function pastArtists(events: LoggedEvent[], current: LoggedEvent): Performer[] {
  const out: Performer[] = [];
  for (const e of events) {
    if (e.id === current.id) continue;
    for (const s of e.seen) if (s.key.length >= 4) out.push({ name: s.name, sourceType: 'user' });
  }
  return out;
}

// The names an event's name may hold, in your words: the part before a
// subtitle (": Nurture Live Tour", " - 10th Anniversary"), split on billing
// markers ("with special guest", "w/", "b2b") and commas. A trailing year
// goes. "Above & Beyond" stays whole.
export function titleParts(name: string): string[] {
  const head = name
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .split(/\s*:\s+|\s+[-–—|]\s+/)[0]
    .trim();
  const pieces: string[] = [];
  const bill = splitBill(head);
  for (const part of bill ? [bill.head, bill.tail] : [head]) {
    pieces.push(...part.split(/\s*,\s*|\s+(?:b2b|B2B|vs\.?)\s+/));
  }
  const seen = new Set<string>();
  return pieces
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => {
      const k = normalizeName(p);
      if (k.length < 2 || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4);
}

// Parts of the name that MusicBrainz knows as an artist of exactly that name.
// One request per part (at most 4), spaced by the shared fetcher.
export async function nameArtistSuggestions(event: LoggedEvent, fetcher: Fetcher): Promise<ArtistSuggestion[]> {
  const seen = new Set(event.seen.map((s) => s.key));
  const found: Performer[] = [];
  for (const part of titleParts(event.name)) {
    if (seen.has(normalizeName(part))) continue;
    const url = await artistNamed(fetcher, part);
    if (url) found.push({ name: part, sourceType: 'musicbrainz', sourceUrl: url });
  }
  return artistSuggestions(event, found);
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
