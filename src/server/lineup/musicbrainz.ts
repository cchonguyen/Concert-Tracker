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

// Artists whose name or an alias is exactly this name, with a high score.
async function exactMatches(fetcher: Fetcher, name: string): Promise<MbArtist[]> {
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`;
  const data = parseJson<{ artists?: MbArtist[] }>(await fetcher.get(url, { headers: { Accept: 'application/json' } }));
  const wanted = normalizeName(name);
  return (data.artists ?? []).filter(
    (a) =>
      (a.score ?? 0) >= 95 &&
      (normalizeName(a.name) === wanted || (a.aliases ?? []).some((al) => normalizeName(al.name) === wanted)),
  );
}

export async function resolveArtist(fetcher: Fetcher, artist: ArtistIdentity): Promise<ArtistIdentity> {
  const exact = await exactMatches(fetcher, artist.name);
  // Two exact matches means an ambiguous name; leave it for a person.
  const mbid = exact.length === 1 ? exact[0].id : undefined;
  return { ...artist, mbid, resolvedAt: new Date().toISOString() };
}

// Whether some artist goes by exactly this name: the link to the first one, or
// null. Only used to offer a name you typed as a one-tap act, never as lineup
// evidence.
export async function artistNamed(fetcher: Fetcher, name: string): Promise<string | null> {
  const [first] = await exactMatches(fetcher, name);
  return first ? `https://musicbrainz.org/artist/${first.id}` : null;
}
