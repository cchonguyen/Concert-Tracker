import { InputError } from '../lineup/pipeline';
import { canonicalName } from '../lineup/merge';
import { artistGenreTags, exactMatches } from '../lineup/musicbrainz';
import { normalizeName } from '../lineup/text';
import type { Fetcher } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { currentMember } from '../auth/requestScope';
import { genreUniverse } from './genreCatalog';
import type { LoggedEvent } from './types';
import { GENRE_MAP_SETTING, MAX_GENRE_LENGTH, MAX_MUSICBRAINZ_GENRES, MAX_OWN_GENRES, MIN_SHARE, MUSIC_STORY_FORMAT } from './genreTypes';
import type { ArtistGenres, GenreChange, GenreMapEntry, GenreShare, GenreSource, GenreVocabulary, KnownGenre } from './genreTypes';
import { GENRE_NEEDS_LETTER, NOT_GROUPED, genreKey, genreResolver } from './genreVocabulary';

export * from './genreTypes';

// Genres of the acts you saw. Two sources, both read in code, never guessed:
// the file music-story exports from your listening history (its curated
// genre map applied to Last.fm, Spotify and MusicBrainz tags), and, only when
// you ask, MusicBrainz genres for acts that file does not cover, mapped through
// the same genre map. An act with no genre from either stays without one.
// The owner's genres (source `owner`) are the shared ones and win over both.
// A member may add genres of their own (source `added`), shown only to them.
// Every shared write goes through writeArtistGenres and is logged.

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

// Weights rescaled to sum to 1, largest first. When every genre has a rank,
// by rank instead.
export function normalizeShares(genres: GenreShare[]): GenreShare[] {
  const total = genres.reduce((s, g) => s + g.weight, 0);
  const ranked = genres.length > 0 && genres.every((g) => typeof g.rank === 'number');
  return genres
    .map((g) => ({ ...g, weight: Math.round((g.weight / total) * 10_000) / 10_000 }))
    .sort((a, b) =>
      ranked ? (a.rank! - b.rank!) : b.weight - a.weight || a.style.localeCompare(b.style),
    );
}

// Owner's genres are weighted by the order they are typed in. Raw decay by
// rank: 1.0, 0.70, 0.45, 0.25, and 0.25 for the fifth to the tenth.
export const OWN_GENRE_DECAY: readonly number[] = [1, 0.7, 0.45, 0.25];

// Weights for n ranked genres (index 0 is rank 1): the decay, scaled to sum to 1.
export function rankedWeights(n: number): number[] {
  const raw = Array.from({ length: Math.max(0, n) }, (_, i) => OWN_GENRE_DECAY[Math.min(i, OWN_GENRE_DECAY.length - 1)]);
  const total = raw.reduce((s, x) => s + x, 0);
  return raw.map((x) => Math.round((x / total) * 10_000) / 10_000);
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
// act in the genre universe (catalog, seen acts, owner records) that it covers.
// Earlier music-story rows for those acts are replaced. One batch per upload.
export async function importMusicStory(store: LineupStore, raw: unknown, now: Date) {
  const { map, artists } = readMusicStory(raw);
  const universe = await genreUniverse(store);
  const rows = matchMusicStory(artists, universe, await store.getAliases(), now.toISOString());
  await store.putSetting(GENRE_MAP_SETTING, map);
  if (rows.length) {
    await store.writeArtistGenres(
      rows.map((r) => ({ key: r.key, source: 'music-story' as const, row: r })),
      { actor: 'system:music-story', reason: 'music-story file upload', batchId: batchId(now) },
    );
  }
  return { matched: rows.length, seen: universe.length, inFile: artists.length, mapTags: map.length };
}

const batchId = (now: Date) => `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// MusicBrainz genres for acts in the genre universe, on request: the stored
// MusicBrainz ID, or the one artist whose name or alias is exactly the act's
// name. Two or more such artists, or none, means no genre. A check that finds
// none is stored too, so the same act is not looked up again unless asked for by key.
export async function musicBrainzGenres(store: LineupStore, fetcher: Fetcher, keys: string[], now: Date) {
  if (keys.length > MAX_MUSICBRAINZ_GENRES) throw new InputError(`At most ${MAX_MUSICBRAINZ_GENRES} artists at a time.`);
  const map = await store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING);
  if (!map?.length) throw new InputError('Import your music-story file first: its genre map is used to read MusicBrainz genres.');
  const universe = new Map((await genreUniverse(store)).map((a) => [a.key, a]));
  const rows: ArtistGenres[] = [];
  for (const key of keys) {
    const act = universe.get(key);
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
  if (rows.length) {
    await store.writeArtistGenres(
      rows.map((r) => ({ key: r.key, source: 'musicbrainz' as const, row: r })),
      { actor: 'system:musicbrainz', reason: 'MusicBrainz lookup' },
    );
  }
  return rows;
}

// Every genre you can pick: the vocabulary's genres, the genre map's styles and
// those on stored acts, once per genreKey, in the resolved spelling and group
// (a genre with no group is "Not grouped").
export function knownGenres(map: GenreMapEntry[], rows: ArtistGenres[], vocabulary?: GenreVocabulary): KnownGenre[] {
  const resolver = genreResolver(vocabulary, map, rows);
  const out = new Map<string, KnownGenre>();
  const add = (style: string) => {
    const r = resolver.resolve(style);
    if (r.key && !out.has(r.key)) out.set(r.key, { style: r.name, parent: r.parent ?? NOT_GROUPED });
  };
  for (const g of vocabulary?.genres ?? []) add(g.name);
  for (const m of map) add(m.style);
  for (const r of rows) for (const g of r.genres) add(g.style);
  return [...out.values()].sort((a, b) => a.style.localeCompare(b.style));
}

// Known genres keyed by genreKey, for the genre rows below.
export function knownGenreMap(map: GenreMapEntry[], rows: ArtistGenres[], vocabulary?: GenreVocabulary): Map<string, KnownGenre> {
  return new Map(knownGenres(map, rows, vocabulary).map((g) => [genreKey(g.style), g]));
}

// A genre row typed in the app or a file: the styles, a known style (same
// genreKey) stored in its resolved spelling and group, a new one as typed and
// "Not grouped". A style with no letter or digit is refused. An empty list means
// "none". Owner rows (`owner`, legacy `you`) keep the typed order as a rank and
// weigh by rank (rankedWeights); other rows get equal weights. Throws InputError
// past the limits. Pure: no store.
function typedGenreRow(
  source: GenreSource,
  known: ReadonlyMap<string, KnownGenre>,
  key: string,
  name: string,
  styles: unknown[],
  now: Date,
): ArtistGenres {
  const picked = new Map<string, KnownGenre>();
  for (const raw of styles) {
    const style = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!style) continue;
    if (style.length > MAX_GENRE_LENGTH) throw new InputError(`A genre can be at most ${MAX_GENRE_LENGTH} characters.`);
    const k = genreKey(style);
    if (!k) throw new InputError(GENRE_NEEDS_LETTER);
    if (!picked.has(k)) picked.set(k, known.get(k) ?? { style, parent: NOT_GROUPED });
  }
  if (picked.size > MAX_OWN_GENRES) throw new InputError(`At most ${MAX_OWN_GENRES} genres per act.`);
  const ranked = source === 'owner' || source === 'you';
  const weights = ranked
    ? rankedWeights(picked.size)
    : Array.from({ length: picked.size }, () => (picked.size ? Math.round((1 / picked.size) * 10_000) / 10_000 : 0));
  return {
    key,
    name,
    source,
    genres: [...picked.values()].map((g, i) => (ranked ? { ...g, weight: weights[i], rank: i + 1 } : { ...g, weight: weights[i] })),
    checkedAt: now.toISOString(),
  };
}

// The owner's shared row for one act (source `owner`).
export function ownerGenreRow(known: ReadonlyMap<string, KnownGenre>, key: string, name: string, styles: unknown[], now: Date): ArtistGenres {
  return typedGenreRow('owner', known, key, name, styles, now);
}

// Legacy row (source `you`), still used by the genres file until it writes `owner` rows.
export function ownGenreRow(known: ReadonlyMap<string, KnownGenre>, key: string, name: string, styles: unknown[], now: Date): ArtistGenres {
  return typedGenreRow('you', known, key, name, styles, now);
}

async function knownFor(store: LineupStore): Promise<Map<string, KnownGenre>> {
  const [map, rows, vocabulary] = await Promise.all([
    store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
    store.listArtistGenres(),
    store.getGenreVocabulary(),
  ]);
  const out = knownGenreMap(map ?? [], rows, vocabulary);
  for (const g of vocabulary?.genres ?? []) {
    const resolved = out.get(g.key);
    if (!resolved) continue;
    for (const a of g.aliases) if (!out.has(a.key)) out.set(a.key, resolved);
  }
  return out;
}

// The owner sets the shared genres of one act in the genre universe. An empty
// list means the owner says it has none; `reset` removes the owner's row so
// the found genres show again. Logged with actor `owner`.
export async function setOwnerGenres(store: LineupStore, key: string, styles: unknown, now: Date, reset = false) {
  const act = (await genreUniverse(store)).find((a) => a.key === key);
  if (!act) throw new InputError('Only acts in the catalog, seen by a member or in your records can have genres.');
  if (reset) {
    await store.writeArtistGenres([{ key, source: 'owner', row: null }], { actor: 'owner', reason: 'Reset to found genres' });
    return null;
  }
  if (!Array.isArray(styles)) throw new InputError('Send { styles: [...] }.');
  const row = ownerGenreRow(await knownFor(store), key, act.name, styles, now);
  await store.writeArtistGenres([{ key, source: 'owner', row }], { actor: 'owner', reason: 'Set in the app' });
  return row;
}

// A member's own genres for one act they saw or keep a record of, added on top
// of the shared ones and shown only to them (source `added`, not logged).
// `reset` removes them.
export async function setMemberAdditions(store: LineupStore, key: string, styles: unknown, now: Date, reset = false) {
  const seen = (await store.listEvents()).flatMap((e) => e.seen).find((s) => s.key === key);
  const entity = !seen ? (await store.listEntities()).find((e) => e.kind === 'artist' && !e.mergedIntoId && e.nameNormalized === key) : undefined;
  if (!seen && !entity) throw new InputError('Only acts you saw can have genres.');
  if (reset) {
    await store.deleteArtistGenres(key, 'added');
    return null;
  }
  if (!Array.isArray(styles)) throw new InputError('Send { styles: [...] }.');
  const row = typedGenreRow('added', await knownFor(store), key, (seen?.name ?? entity?.name)!, styles, now);
  await store.putArtistGenres([row]);
  return row;
}

// PUT /api/artist-genres/:key: the owner (or a store outside a member request)
// sets the shared genres; a member sets their own additions.
export async function setOwnGenres(store: LineupStore, key: string, styles: unknown, now: Date, reset = false) {
  return currentMember()?.role === 'member'
    ? setMemberAdditions(store, key, styles, now, reset)
    : setOwnerGenres(store, key, styles, now, reset);
}

// Shared rows compared without checkedAt: a re-check that changes only the time is not a change.
function sameRow(a: ArtistGenres | null | undefined, b: ArtistGenres | null | undefined): boolean {
  const bare = (r: ArtistGenres | null | undefined) =>
    r
      ? JSON.stringify({
          name: r.name,
          mbid: r.mbid || null,
          genres: r.genres.map((g) => [g.parent, g.style, g.weight]),
          sourceUrl: r.sourceUrl || null,
          inputs: r.inputs?.length ? r.inputs : null,
        })
      : null;
  return bare(a) === bare(b);
}

const isUndoReason = (reason: string) => /^undo\b/i.test(reason);

// Undoes the newest change to one act's shared genres that is not undone yet
// (an undo itself is skipped, so repeated undos walk back). Refused when the
// row was changed since. Restores the row as it was, logged as the owner's Undo.
export async function undoGenreChange(store: LineupStore, key: string, now: Date): Promise<{ change: GenreChange; restored: ArtistGenres | null }> {
  const change = (await store.listGenreChanges({ key })).find((c) => !c.undoneAt && !isUndoReason(c.reason));
  if (!change) throw new InputError('There is no change to undo for this artist.');
  const current = (await store.listArtistGenres()).find((r) => r.key === key && r.source === change.source) ?? null;
  if (!sameRow(current, change.after)) throw new InputError('Changed since; nothing undone.');
  const restored = change.before ? { ...change.before, key, source: change.source } : null;
  await store.writeArtistGenres([{ key, source: change.source, row: restored }], { actor: 'owner', reason: 'Undo' });
  await store.markGenreChangesUndone([change.id], now.toISOString());
  return { change, restored };
}
