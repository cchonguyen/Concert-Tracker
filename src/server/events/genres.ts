import { InputError } from '../lineup/pipeline';
import { canonicalName } from '../lineup/merge';
import { artistGenreTags, exactMatches } from '../lineup/musicbrainz';
import { normalizeName } from '../lineup/text';
import type { Fetcher } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import type { LoggedEvent } from './types';
import { GENRE_MAP_SETTING, MAX_GENRE_LENGTH, MAX_MUSICBRAINZ_GENRES, MAX_OWN_GENRES, MIN_SHARE, MUSIC_STORY_FORMAT } from './genreTypes';
import type { ArtistGenres, GenreMapEntry, GenreShare, KnownGenre } from './genreTypes';

export * from './genreTypes';

// Genres of the acts you saw. Two sources, both read in code, never guessed:
// the file music-story exports from your listening history (its curated
// genre map applied to Last.fm, Spotify and MusicBrainz tags), and, only when
// you ask, MusicBrainz genres for acts that file does not cover, mapped through
// the same genre map. An act with no genre from either stays without one.
// Genres you set on an act yourself (source `you`) win over both.

interface MusicStoryArtist {
  name: string;
  mbid?: string;
  genres: GenreShare[];
  inputs: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Reads and checks a music-story export. Entries it cannot read are skipped.
export function readMusicStory(raw: unknown): { map: GenreMapEntry[]; artists: MusicStoryArtist[] } {
  const doc = raw as any;
  if (!doc || doc.format !== MUSIC_STORY_FORMAT) throw new InputError('This is not a music-story artist genre file.');
  if (doc.version !== 1) throw new InputError(`Unsupported music-story file version ${String(doc.version)}.`);
  const map: GenreMapEntry[] = [];
  for (const m of Array.isArray(doc.genre_map) ? doc.genre_map : []) {
    const tag = str(m?.tag).toLowerCase();
    const style = str(m?.style);
    const parent = str(m?.parent);
    if (tag && style && parent) map.push({ tag, style, parent });
  }
  if (!map.length) throw new InputError('The music-story file has no genre map.');
  const artists: MusicStoryArtist[] = [];
  for (const a of Array.isArray(doc.artists) ? doc.artists : []) {
    const name = str(a?.name);
    const genres = (Array.isArray(a?.genres) ? a.genres : [])
      .map((g: any) => ({ parent: str(g?.parent), style: str(g?.style), weight: Number(g?.weight) }))
      .filter((g: GenreShare) => g.parent && g.style && Number.isFinite(g.weight) && g.weight > 0);
    if (!name || !genres.length) continue;
    artists.push({
      name,
      mbid: str(a?.mbid) || undefined,
      genres: normalizeShares(genres),
      inputs: (Array.isArray(a?.inputs) ? a.inputs : []).map(str).filter(Boolean),
    });
  }
  return { map, artists };
}

// Weights rescaled to sum to 1, largest first.
function normalizeShares(genres: GenreShare[]): GenreShare[] {
  const total = genres.reduce((s, g) => s + g.weight, 0);
  return genres
    .map((g) => ({ ...g, weight: Math.round((g.weight / total) * 10_000) / 10_000 }))
    .sort((a, b) => b.weight - a.weight || a.style.localeCompare(b.style));
}

// Tags with counts mapped through the genre map: unmapped tags are ignored,
// shares under MIN_SHARE dropped, the rest rescaled to sum to 1.
export function mapTags(tags: Array<{ name: string; count: number }>, map: GenreMapEntry[]): GenreShare[] {
  const byTag = new Map(map.map((m) => [m.tag, m]));
  const byStyle = new Map<string, GenreShare>();
  for (const t of tags) {
    const m = byTag.get(t.name.trim().toLowerCase());
    if (!m || !(t.count > 0)) continue;
    const k = `${m.parent}|${m.style}`;
    const g = byStyle.get(k) ?? { parent: m.parent, style: m.style, weight: 0 };
    g.weight += t.count;
    byStyle.set(k, g);
  }
  const all = [...byStyle.values()];
  const total = all.reduce((s, g) => s + g.weight, 0);
  const kept = all.filter((g) => g.weight >= MIN_SHARE * total);
  return kept.length ? normalizeShares(kept) : [];
}

export interface SeenArtist {
  key: string;
  name: string;
  mbid?: string;
}

// Every act you marked as seen, once, with its MusicBrainz ID when one is stored.
export async function seenArtists(store: LineupStore, events: LoggedEvent[]): Promise<SeenArtist[]> {
  const byKey = new Map<string, SeenArtist>();
  for (const e of events) for (const s of e.seen) if (!byKey.has(s.key)) byKey.set(s.key, { key: s.key, name: s.name });
  for (const a of await store.getArtists([...byKey.keys()])) {
    const seen = byKey.get(a.key);
    if (seen && a.mbid) seen.mbid = a.mbid;
  }
  return [...byKey.values()];
}

// music-story artists matched to acts you saw: by MusicBrainz ID first, then
// by name (your renames applied). Artists you never saw are not kept.
export function matchMusicStory(
  artists: MusicStoryArtist[],
  seen: SeenArtist[],
  aliases: Record<string, string>,
  now: string,
): ArtistGenres[] {
  const byMbid = new Map(artists.filter((a) => a.mbid).map((a) => [a.mbid!, a]));
  const byName = new Map<string, MusicStoryArtist>();
  for (const a of artists) {
    for (const k of [normalizeName(a.name), normalizeName(canonicalName(a.name, aliases))]) if (!byName.has(k)) byName.set(k, a);
  }
  const out: ArtistGenres[] = [];
  for (const s of seen) {
    const hit = (s.mbid && byMbid.get(s.mbid)) || byName.get(s.key);
    if (!hit) continue;
    out.push({
      key: s.key,
      name: s.name,
      source: 'music-story',
      mbid: hit.mbid,
      genres: hit.genres,
      inputs: hit.inputs,
      checkedAt: now,
    });
  }
  return out;
}

// Imports a music-story file: keeps its genre map and the genres of every
// act you saw that it covers. Earlier music-story rows for those acts are replaced.
export async function importMusicStory(store: LineupStore, raw: unknown, now: Date) {
  const { map, artists } = readMusicStory(raw);
  const seen = await seenArtists(store, await store.listEvents());
  const rows = matchMusicStory(artists, seen, await store.getAliases(), now.toISOString());
  await store.putSetting(GENRE_MAP_SETTING, map);
  await store.putArtistGenres(rows);
  return { matched: rows.length, seen: seen.length, inFile: artists.length, mapTags: map.length };
}

// MusicBrainz genres for acts you saw, on request: the stored MusicBrainz ID,
// or the one artist whose name or alias is exactly the act's name. Two or more
// such artists, or none, means no genre. A check that finds none is stored
// too, so the same act is not looked up again unless you ask for it by key.
export async function musicBrainzGenres(store: LineupStore, fetcher: Fetcher, keys: string[], now: Date) {
  if (keys.length > MAX_MUSICBRAINZ_GENRES) throw new InputError(`At most ${MAX_MUSICBRAINZ_GENRES} artists at a time.`);
  const map = await store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING);
  if (!map?.length) throw new InputError('Import your music-story file first: its genre map is used to read MusicBrainz genres.');
  const seen = new Map((await seenArtists(store, await store.listEvents())).map((a) => [a.key, a]));
  const rows: ArtistGenres[] = [];
  for (const key of keys) {
    const act = seen.get(key);
    if (!act) continue;
    let mbid = act.mbid;
    if (!mbid) {
      const exact = await exactMatches(fetcher, act.name);
      mbid = exact.length === 1 ? exact[0].id : undefined;
    }
    const genres = mbid ? mapTags(await artistGenreTags(fetcher, mbid), map) : [];
    rows.push({
      key,
      name: act.name,
      source: 'musicbrainz',
      mbid,
      genres,
      sourceUrl: mbid ? `https://musicbrainz.org/artist/${mbid}` : undefined,
      checkedAt: now.toISOString(),
    });
  }
  await store.putArtistGenres(rows);
  return rows;
}

// Every genre you can pick: the genre map's styles and those on stored acts,
// yours included, by name.
export function knownGenres(map: GenreMapEntry[], rows: ArtistGenres[]): KnownGenre[] {
  const out = new Map<string, KnownGenre>();
  for (const m of map) out.set(m.style.toLowerCase(), { style: m.style, parent: m.parent });
  for (const r of rows) for (const g of r.genres) if (!out.has(g.style.toLowerCase())) out.set(g.style.toLowerCase(), { style: g.style, parent: g.parent });
  return [...out.values()].sort((a, b) => a.style.localeCompare(b.style));
}

// Your own genres for one act you saw ({ name, styles }), equal weights. A
// style you already know keeps its known spelling and parent genre; a new one
// is its own parent. An empty list means you say it has none; `reset` drops
// your genres so the found ones show again.
export async function setOwnGenres(store: LineupStore, key: string, styles: unknown, now: Date, reset = false) {
  const seen = (await store.listEvents()).flatMap((e) => e.seen).find((s) => s.key === key);
  const entity = !seen ? (await store.listEntities()).find((e) => e.kind === 'artist' && !e.mergedIntoId && e.nameNormalized === key) : undefined;
  if (!seen && !entity) throw new InputError('Only acts you saw can have genres.');
  if (reset) {
    await store.deleteArtistGenres(key, 'you');
    return null;
  }
  if (!Array.isArray(styles)) throw new InputError('Send { styles: [...] }.');
  const [map, rows] = await Promise.all([store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING), store.listArtistGenres()]);
  const known = new Map(knownGenres(map ?? [], rows).map((g) => [g.style.toLowerCase(), g]));
  const picked = new Map<string, KnownGenre>();
  for (const raw of styles) {
    const style = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!style) continue;
    if (style.length > MAX_GENRE_LENGTH) throw new InputError(`A genre can be at most ${MAX_GENRE_LENGTH} characters.`);
    const k = style.toLowerCase();
    if (!picked.has(k)) picked.set(k, known.get(k) ?? { style, parent: style });
  }
  if (picked.size > MAX_OWN_GENRES) throw new InputError(`At most ${MAX_OWN_GENRES} genres per act.`);
  const weight = picked.size ? Math.round((1 / picked.size) * 10_000) / 10_000 : 0;
  const row: ArtistGenres = {
    key,
    name: (seen?.name ?? entity?.name)!,
    source: 'you',
    genres: [...picked.values()].map((g) => ({ ...g, weight })),
    checkedAt: now.toISOString(),
  };
  await store.putArtistGenres([row]);
  return row;
}
