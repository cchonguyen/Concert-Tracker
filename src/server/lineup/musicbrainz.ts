import { ArtistIdentity, Fetcher } from './types';
import { parseJson } from './http';
import { normalizeName } from './text';

// MusicBrainz gives a stable artist ID so spelling variants merge, and, only
// when you ask, an artist's genres (src/server/events/genres.ts). Matches are accepted only on an exact normalized name or alias match
// with a high search score; otherwise the artist stays unresolved.

interface MbArtist {
  id: string;
  name: string;
  score?: number;
  aliases?: Array<{ name: string }>;
}

// MusicBrainz could not answer right now (502/503/504, 429, or no answer at all).
// Not a verdict on the artist: the caller parks the job and tries later. It never
// falls back to a guess or another provider. 4xx besides 429 stay plain HttpErrors.
export class MusicBrainzUnavailableError extends Error {
  constructor(
    message: string,
    // Seconds from a Retry-After header, when MusicBrainz sent one.
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

function retryAfterSeconds(raw: string | undefined, now = Date.now()): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000)) || undefined;
}

// One MusicBrainz GET through the shared rate-limited fetcher (1 request/second).
async function mbGet<T>(fetcher: Fetcher, url: string): Promise<T> {
  let res;
  try {
    res = await fetcher.get(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new MusicBrainzUnavailableError(`MusicBrainz did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (TRANSIENT_STATUSES.has(res.status)) {
    throw new MusicBrainzUnavailableError(
      `MusicBrainz is unavailable (HTTP ${res.status}).`,
      res.status === 429 ? retryAfterSeconds(res.headers?.['retry-after']) : undefined,
    );
  }
  return parseJson<T>(res);
}

// Artists whose name or an alias is exactly this name, with a high score.
export async function exactMatches(fetcher: Fetcher, name: string): Promise<MbArtist[]> {
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`;
  const data = await mbGet<{ artists?: MbArtist[] }>(fetcher, url);
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

// An artist's genres as MusicBrainz users voted them: tag name and vote count.
export async function artistGenreTags(fetcher: Fetcher, mbid: string): Promise<Array<{ name: string; count: number }>> {
  const url = `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?inc=genres&fmt=json`;
  const data = await mbGet<{ genres?: Array<{ name: string; count?: number }> }>(fetcher, url);
  return (data.genres ?? []).map((g) => ({ name: g.name, count: g.count ?? 1 }));
}
