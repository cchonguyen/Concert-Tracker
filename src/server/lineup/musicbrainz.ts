import { ArtistIdentity, Fetcher } from './types';
import { parseJson } from './http';
import { normalizeName } from './text';

// MusicBrainz is used for one thing: a stable artist ID so spelling variants
// merge. Matches are accepted only on an exact normalized name or alias match
// with a high search score; otherwise the artist stays unresolved.

interface MbArtist {
  id: string;
  name: string;
  score?: number;
  aliases?: Array<{ name: string }>;
}

export async function resolveArtist(fetcher: Fetcher, artist: ArtistIdentity): Promise<ArtistIdentity> {
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${artist.name}"`)}&fmt=json&limit=5`;
  const data = parseJson<{ artists?: MbArtist[] }>(await fetcher.get(url, { headers: { Accept: 'application/json' } }));
  const wanted = normalizeName(artist.name);
  const exact = (data.artists ?? []).filter(
    (a) =>
      (a.score ?? 0) >= 95 &&
      (normalizeName(a.name) === wanted || (a.aliases ?? []).some((al) => normalizeName(al.name) === wanted)),
  );
  // Two exact matches means an ambiguous name; leave it for a person.
  const mbid = exact.length === 1 ? exact[0].id : undefined;
  return { ...artist, mbid, resolvedAt: new Date().toISOString() };
}
