// Every act that can have shared genres (docs/specs/canonical-genres.md, section 1).
// Once by key, first name wins: the shared lineup catalog (with its MusicBrainz
// IDs), then every act any member marked as seen (names only, through
// seen_act_names()), then the owner's own live artist records. Owner and system
// scope only: listSeenActNames refuses a member.

import { isCiphertext } from '../auth/vault';
import type { LineupStore } from '../lineup/store/types';

export interface UniverseArtist {
  key: string;
  name: string;
  mbid?: string;
}

export async function genreUniverse(store: LineupStore): Promise<UniverseArtist[]> {
  const [catalog, seen, entities] = await Promise.all([store.listArtists(), store.listSeenActNames(), store.listEntities()]);
  const byKey = new Map<string, UniverseArtist>();
  const add = (key: string, name: string, mbid?: string) => {
    const k = key.trim();
    const n = name.trim();
    if (!k || !n || byKey.has(k) || isCiphertext(n)) return;
    byKey.set(k, mbid ? { key: k, name: n, mbid } : { key: k, name: n });
  };
  for (const a of catalog) add(a.key, a.name, a.mbid);
  for (const s of seen) add(s.key, s.name);
  for (const e of entities) if (e.kind === 'artist' && !e.mergedIntoId) add(e.nameNormalized, e.name);
  return [...byKey.values()];
}
