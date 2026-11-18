// Matches a shared edition's name to catalog artists (docs/edition-lineup-from-name-spec.md, slice 1).
// Pure: no store, no network, no model. Only the catalog list passed in is considered, never personal entities.
import { normalizeName } from '../lineup/normalizeName';

export interface CatalogArtist {
  key: string;
  name: string;
}

export interface EditionNameArtistMatch {
  artistKey: string;
  artistName: string;
  // The edition's own name. It is the stored source document for the act; the matched words are its prefix.
  quote: string;
}

// The artist must be a whole-word prefix of the edition name. The longest prefix wins; a tie offers nothing.
// If the words after the prefix are exactly a known series, brand or venue (normalized), nothing is offered.
export function matchEditionName(
  editionName: string,
  artists: CatalogArtist[],
  blockedRemainders: ReadonlySet<string> = new Set(),
): EditionNameArtistMatch | null {
  const words = normalizeName(editionName).split(' ').filter(Boolean);
  if (words.length === 0) return null;

  let best: { artist: CatalogArtist; length: number } | null = null;
  let tied = false;
  for (const artist of artists) {
    const artistWords = normalizeName(artist.name).split(' ').filter(Boolean);
    if (artistWords.length === 0 || artistWords.length > words.length) continue;
    if (!artistWords.every((w, i) => words[i] === w)) continue;
    if (!best || artistWords.length > best.length) {
      best = { artist, length: artistWords.length };
      tied = false;
    } else if (artistWords.length === best.length) {
      tied = true;
    }
  }
  if (!best || tied) return null;

  const remainder = words.slice(best.length).join(' ');
  if (remainder && blockedRemainders.has(remainder)) return null;

  return { artistKey: best.artist.key, artistName: best.artist.name, quote: editionName };
}

// The payload a member's lineup proposal stores (slice 4). Only the act and the edition's name: never a user id or a personal field.
export interface LineupProposalPayload {
  artistKey: string;
  artistName: string;
  editionName: string;
  quote: string;
}

export function lineupProposalPayload(editionName: string, artist: CatalogArtist): LineupProposalPayload {
  return { artistKey: artist.key, artistName: artist.name, editionName, quote: editionName };
}

// The catalog acts each edition's name offers that its lineup does not have yet (slice 5). Pure: the caller passes the editions and catalog.
export interface EditionNameOffer {
  editionId: string;
  artistKey: string;
  artistName: string;
}

export function offersForEditions(
  editions: Array<{ id: string; name: string; performances: Array<{ artistKey: string }> }>,
  artists: CatalogArtist[],
  blockedRemainders: ReadonlySet<string> = new Set(),
): EditionNameOffer[] {
  const offers: EditionNameOffer[] = [];
  for (const edition of editions) {
    const match = matchEditionName(edition.name, artists, blockedRemainders);
    if (!match) continue;
    if (edition.performances.some((p) => p.artistKey === match.artistKey)) continue;
    offers.push({ editionId: edition.id, artistKey: match.artistKey, artistName: match.artistName });
  }
  return offers;
}
