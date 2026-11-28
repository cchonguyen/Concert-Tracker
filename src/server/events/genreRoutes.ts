import { Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { currentMember } from '../auth/requestScope';
import type { GenreVocabWriteRow, LineupStore } from '../lineup/store/types';
import {
  ArtistGenres,
  GENRE_MAP_SETTING,
  GenreMapEntry,
  importMusicStory,
  knownGenres,
  musicBrainzGenres,
  setMemberAdditions,
  setOwnerGenres,
  undoGenreChange,
} from './genres';
import {
  applyGenresCsv,
  exportGenresCsv,
  genresCsvUndoStatus,
  previewGenresCsv,
  undoGenresCsv,
} from './genreCsvApply';
import { genreCollisions, genreResolver, levelOf } from './genreVocabulary';
import { ArtistOrbitError, isMissingOrbitFunction, orbitsForMember } from './artistOrbits';
import { applyArtistOrbitsCsv, exportArtistOrbitsCsv, previewArtistOrbitsCsv } from './artistOrbitsCsv';
import type { GenreRelation, GenreVocabChange, GenreVocabulary } from './genreTypes';
import { billsFrom, lineupCooccur, type CooccurPerformance } from './lineupCooccur';
import { genresByArtist } from '../../services/genres';
import {
  addGenreAlias,
  addGenreUmbrella,
  applyGenreVocabCsv,
  addGenreRelation,
  createGenre,
  mergeGenres,
  pickGenreSpelling,
  planGenreMerge,
  previewGenreVocabCsv,
  removeGenreAlias,
  removeGenreRelation,
  removeGenreUmbrella,
  renameGenre,
  setGenreFamily,
  setGenreParent,
  setGenreRelationWeight,
  undoGenreVocabChange,
} from './genreVocabularyManage';
import { applyGenreRelationsCsv, imageWith, previewGenreRelationsCsv, sameRelations } from './genreRelationsCsv';
import { ManageError } from '../entities/manage';
import { eventPerformers } from './artists';
import { normalizeName } from '../lineup/text';
import type { Edition, LookupJob } from '../lineup/types';
import type { LoggedEvent } from './types';

// One act on an event's lineup: its key and name, and what the lineup says about where and when it plays.
export interface LineupGenresAct {
  key: string;
  name: string;
  alias?: string;
  stages: string[];
  days: string[];
  status?: 'billed' | 'performed';
  slotId?: string;
}

// The stored stage, day and status for each act, from the same sources eventPerformers reads
// (the edition's performances without cancelled ones, the lookup's candidate, the confirmed listing).
// The first source to name an act wins. Acts with none get empty stages and days.
function lineupInfo(event: LoggedEvent, job: LookupJob | null, edition: Edition | null): Map<string, Omit<LineupGenresAct, 'key' | 'name'>> {
  const info = new Map<string, Omit<LineupGenresAct, 'key' | 'name'>>();
  const note = (name: string, i: Omit<LineupGenresAct, 'key' | 'name'>) => {
    const key = normalizeName(name);
    if (key && !info.has(key)) info.set(key, i);
  };
  for (const p of edition?.performances ?? []) {
    if (p.status !== 'cancelled') note(p.name, { stages: p.stages ?? [], days: p.days ?? [], status: p.status, slotId: p.slotId, ...(p.alias ? { alias: p.alias } : {}) });
  }
  for (const p of job?.candidate?.performers ?? []) {
    note(p.name, { stages: p.stages ?? [], days: p.days ?? [], status: p.status, slotId: p.slotId, ...(p.alias ? { alias: p.alias } : {}) });
  }
  return info;
}

// The acts on an event's lineup, one per act (by normalized name), in the order eventPerformers gives them.
// Nothing is rejected or hidden here: eventPerformers already leaves out what sources did not list.
export function lineupActs(event: LoggedEvent, job: LookupJob | null, edition: Edition | null): LineupGenresAct[] {
  const info = lineupInfo(event, job, edition);
  const out: LineupGenresAct[] = [];
  const seen = new Set<string>();
  for (const p of eventPerformers(event, job, edition)) {
    const key = normalizeName(p.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const i = info.get(key);
    out.push({ key, name: p.name, ...(i?.alias ? { alias: i.alias } : {}), stages: i?.stages ?? [], days: i?.days ?? [], ...(i?.status ? { status: i.status } : {}), ...(i?.slotId ? { slotId: i.slotId } : {}) });
  }
  return out;
}

// The taxonomy as its own keys, read from the vocabulary (no extra query): the families and macros,
// and every outgoing link. Shared data with no personal fields, so every scope gets it.
export function taxonomyPayload(vocabulary: GenreVocabulary): {
  levels: Array<{ key: string; name: string; level: 'family' | 'macro'; primaryParent?: string }>;
  relations: Array<{ source: string; target: string; type: string; weight: number; origin: string }>;
} {
  const levels = vocabulary.genres
    .filter((g) => g.level === 'family' || g.level === 'macro')
    .map((g) => ({ key: g.key, name: g.name, level: g.level as 'family' | 'macro', ...(g.primaryParent ? { primaryParent: g.primaryParent } : {}) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const relations = vocabulary.genres
    .flatMap((g) => (g.relations ?? []).map((r) => ({ source: g.key, target: r.target, type: r.type, weight: r.weight, origin: r.origin })))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return { levels, relations };
}

// How many of the newest vocabulary changes the owner's GET carries.
export const VOCAB_CHANGES_LIMIT = 100;

const isMember = () => currentMember()?.role === 'member';
export const ORBIT_CHANGES_LIMIT = 20;
const ORBIT_MEMBER_REFUSED = 'Only the owner changes artist orbits.';

// The owner's vocabulary writes, by the last part of the path. Each gets the
// request body and returns the change it wrote.
type VocabWrite = (store: LineupStore, b: Record<string, unknown>) => Promise<unknown>;
const VOCAB_WRITES: Record<string, VocabWrite> = {
  create: async (s, b) => ({ change: await createGenre(s, { name: b.name, parent: b.parent, family: b.family }) }),
  rename: async (s, b) => ({ change: await renameGenre(s, b.genre, b.name) }),
  'alias-add': async (s, b) => ({ change: await addGenreAlias(s, b.genre, b.alias) }),
  'alias-remove': async (s, b) => ({ change: await removeGenreAlias(s, b.genre, b.alias) }),
  parent: async (s, b) => ({ change: await setGenreParent(s, b.genre, b.parent) }),
  family: async (s, b) => ({ change: await setGenreFamily(s, b.genre, b.family) }),
  'relation-add': async (s, b) => ({ change: await addGenreRelation(s, b.source, b.target, b.type, b.weight) }),
  'relation-remove': async (s, b) => ({ change: await removeGenreRelation(s, b.source, b.target, b.type) }),
  'relation-weight': async (s, b) => ({ change: await setGenreRelationWeight(s, b.source, b.target, b.type, b.weight) }),
  'umbrella-add': async (s, b) => ({ change: await addGenreUmbrella(s, b.genre, b.umbrella) }),
  'umbrella-remove': async (s, b) => ({ change: await removeGenreUmbrella(s, b.genre, b.umbrella) }),
  spelling: async (s, b) => ({ change: await pickGenreSpelling(s, b.key, b.spelling) }),
  'merge-preview': async (s, b) => ({ plan: await planGenreMerge(s, b.drop, b.keep) }),
  merge: async (s, b) => mergeGenres(s, b.drop, b.keep),
};
const MEMBER_REFUSED = 'Only the owner changes the genre list.';

// A member is sent shared genre rows only for acts in their own events or
// artist records; their own additions always come back. The owner (and a
// request outside multi-user mode) gets every row.
// The act keys a member has: the acts on their own events, and their own artist records.
async function memberActKeys(store: LineupStore): Promise<Set<string>> {
  const [events, entities] = await Promise.all([store.listEvents(), store.listEntities()]);
  const keys = new Set<string>(events.flatMap((e) => e.seen.map((s) => s.key)));
  for (const e of entities) if (e.kind === 'artist' && !e.mergedIntoId) keys.add(e.nameNormalized);
  return keys;
}

async function visibleGenres(store: LineupStore): Promise<ArtistGenres[]> {
  const rows = await store.listArtistGenres();
  if (!isMember()) return rows;
  const keys = await memberActKeys(store);
  return rows.filter((r) => r.source === 'added' || keys.has(r.key));
}

// Bill links (docs/specs/genre-taxonomy-release-3.md section 7). Learns 'adjacent' links from shared lineups.
// Reads shared tables only (editions, performances, artist_genres, the vocabulary). Apply replaces the
// origin 'lineup_cooccur' rows through writeGenreVocabulary, the same write the links CSV uses, so undo
// is the existing genre_changes undo. Other origins are never touched.
const LINEUP_ORIGIN = 'lineup_cooccur';
const LINEUP_ACTOR = 'system:lineup-cooccur';
const LINEUP_REASON = 'Learned from shared lineups';
// Every edition is read: the job needs every shared bill.
const LINEUP_EDITIONS_LIMIT = 100000;

export interface LineupLinkAdded {
  source: string;
  target: string;
  sourceName: string;
  targetName: string;
  weight: number;
  bills: number;
}

export interface LineupLinksPreview {
  billsUsed: number;
  genres: number;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  addedLinks: LineupLinkAdded[];
}

const pairId = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

// Plans the lineup links from the shared data. Writes nothing.
async function planLineupLinks(store: LineupStore): Promise<{ preview: LineupLinksPreview; after: GenreVocabWriteRow[] }> {
  const [vocab, rows, map, editions] = await Promise.all([
    store.getGenreVocabulary(),
    store.listArtistGenres(),
    store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
    store.listEditions(LINEUP_EDITIONS_LIMIT),
  ]);
  const genreMap = map ?? [];
  const byKey = new Map(vocab.genres.map((g) => [g.key, g]));
  const isGenre = (k: string): boolean => {
    const g = byKey.get(k);
    return g !== undefined && levelOf(g) === 'genre';
  };

  // The row the app shows for each act: owner, then music-story, then MusicBrainz. Member additions are not used.
  const base = rows.filter((r) => r.source !== 'added');
  const shown = genresByArtist(base, vocab, genreMap);
  const resolver = genreResolver(vocab, genreMap, base);
  const genresOf = (artistKey: string): string[] => {
    const row = shown.get(artistKey);
    if (!row) return [];
    return row.genres.map((g) => resolver.resolve(g.style).key).filter((k) => k !== '');
  };

  // Pairs never learned: every curated link (any type) and the owner's artist_cooccur adjacent pairs.
  // Stored lineup_cooccur rows are the ones this job replaces.
  const skip = new Set<string>();
  const current = new Map<string, { source: string; target: string; weight: number }>();
  for (const g of vocab.genres) {
    for (const r of g.relations ?? []) {
      if (r.origin === 'curated' || (r.type === 'adjacent' && r.origin === 'artist_cooccur')) skip.add(`${g.key}|${r.target}`);
      if (r.type === 'adjacent' && r.origin === LINEUP_ORIGIN) current.set(pairId(g.key, r.target), { source: g.key, target: r.target, weight: r.weight });
    }
  }

  const perfs: CooccurPerformance[] = editions.flatMap((e) =>
    (e.performances ?? []).map((p) => ({ editionId: e.id, artistKey: p.artistKey, stages: p.stages ?? [], status: p.status, slotId: p.slotId })),
  );
  const result = lineupCooccur(billsFrom(perfs), genresOf, { curated: skip });
  // Only links whose both genres are genre rows in the vocabulary are kept.
  const links = result.links.filter((l) => isGenre(l.source) && isGenre(l.target));

  const next = new Set<string>();
  const addedLinks: LineupLinkAdded[] = [];
  let changed = 0;
  let unchanged = 0;
  const fresh = new Map<string, GenreRelation[]>();
  for (const l of links) {
    const id = pairId(l.source, l.target);
    next.add(id);
    const old = current.get(id);
    if (!old) {
      addedLinks.push({
        source: l.source,
        target: l.target,
        sourceName: byKey.get(l.source)?.name ?? l.source,
        targetName: byKey.get(l.target)?.name ?? l.target,
        weight: l.weight,
        bills: l.bills,
      });
    } else if (old.weight !== l.weight) changed++;
    else unchanged++;
    const list = fresh.get(l.source) ?? [];
    list.push({ target: l.target, type: 'adjacent', weight: l.weight, origin: LINEUP_ORIGIN });
    fresh.set(l.source, list);
  }
  const removed = [...current.keys()].filter((id) => !next.has(id)).length;

  // Each genre whose links change gets a full image, built the same way the links CSV builds it.
  const after: GenreVocabWriteRow[] = [];
  for (const g of vocab.genres) {
    const stored = g.relations ?? [];
    const kept = stored.filter((r) => !(r.type === 'adjacent' && r.origin === LINEUP_ORIGIN));
    const relations = [...kept, ...(fresh.get(g.key) ?? [])];
    if (sameRelations(stored, relations)) continue;
    after.push({ key: g.key, image: imageWith(g, relations) });
  }
  after.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    after,
    preview: {
      billsUsed: result.billsUsed,
      genres: result.genres.length,
      added: addedLinks.length,
      removed,
      changed,
      unchanged,
      addedLinks,
    },
  };
}

// Writes the planned links as one logged change (operation 'relations-import', as the links CSV does).
async function applyLineupLinks(store: LineupStore): Promise<{ preview: LineupLinksPreview; change: GenreVocabChange | null }> {
  const plan = await planLineupLinks(store);
  const p = plan.preview;
  if (plan.after.length === 0) return { preview: p, change: null };
  const change = await store.writeGenreVocabulary(plan.after, {
    operation: 'relations-import',
    actor: LINEUP_ACTOR,
    reason: LINEUP_REASON,
    summary: `Learned lineup links: ${p.added} added, ${p.removed} removed, ${p.changed} weight changed across ${plan.after.length} genres`,
  });
  return { preview: p, change };
}

// /api/artist-genres: genres of the acts you saw (see ARCHITECTURE.md, Artist genres).
export function genresRouter(deps: PipelineDeps): Router {
  const router = Router();
  const fail = (res: any, err: unknown) =>
    res
      .status(err instanceof ManageError ? err.status : err instanceof InputError ? 400 : 500)
      .json({ error: err instanceof Error ? err.message : String(err) });

  // Every scope gets the vocabulary and the genre map. Only the owner gets the
  // vocabulary's change log and the spellings that collide: a member's
  // additions never reach either (docs/archive/genre-vocabulary.md section 8).
  router.get('/artist-genres', async (_req, res) => {
    try {
      const member = isMember();
      const [genres, map, csvUndo, vocabulary] = await Promise.all([
        visibleGenres(deps.store),
        deps.store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
        member ? null : genresCsvUndoStatus(deps.store),
        deps.store.getGenreVocabulary(),
      ]);
      const body: Record<string, unknown> = {
        genres,
        hasMap: Boolean(map?.length),
        known: knownGenres(map ?? [], genres, vocabulary),
        csvUndo,
        vocabulary,
        ...taxonomyPayload(vocabulary),
        map: map ?? [],
      };
      if (!member) {
        body.vocabularyChanges = await deps.store.listGenreVocabChanges({ limit: VOCAB_CHANGES_LIMIT });
        body.collisions = genreCollisions(genres, vocabulary, map ?? []);
      }
      res.json(body);
    } catch (err) {
      fail(res, err);
    }
  });

  // The downloadable CSV of the acts you can give genres (see docs/archive/genres-csv.md).
  router.get('/artist-genres/csv/export', async (_req, res) => {
    try {
      const day = deps.now().toISOString().slice(0, 10);
      res.setHeader('Content-Disposition', `attachment; filename="artists-and-genres-${day}.csv"`);
      res.type('text/csv; charset=utf-8').send(await exportGenresCsv(deps.store));
    } catch (err) {
      fail(res, err);
    }
  });

  // Matches and checks an uploaded file's rows. Changes nothing. Max 5,000 rows with new genres.
  router.post('/artist-genres/csv/preview', async (req, res) => {
    try {
      res.json(await previewGenresCsv(deps.store, req.body));
    } catch (err) {
      fail(res, err);
    }
  });

  // Saves the matched, valid, not-stale rows and records the undo for this upload.
  router.post('/artist-genres/csv/apply', async (req, res) => {
    try {
      res.json(await applyGenresCsv(deps.store, req.body, deps.now()));
    } catch (err) {
      fail(res, err);
    }
  });

  // Puts back the latest upload (only the latest can be undone).
  router.post('/artist-genres/csv/undo', async (_req, res) => {
    try {
      res.json(await undoGenresCsv(deps.store, deps.now()));
    } catch (err) {
      fail(res, err);
    }
  });

  // The file `pipeline.artist_genre export` wrote in music-story, as JSON.
  router.post('/artist-genres/music-story', async (req, res) => {
    try {
      res.json(await importMusicStory(deps.store, req.body, deps.now()));
    } catch (err) {
      fail(res, err);
    }
  });

  // MusicBrainz genres for a few acts you saw ({ keys }); the client sends the rest in turn.
  router.post('/artist-genres/musicbrainz', async (req, res) => {
    try {
      const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
      res.json({ genres: await musicBrainzGenres(deps.store, deps.fetcher, keys, deps.now()) });
    } catch (err) {
      fail(res, err);
    }
  });

  // The owner's vocabulary writes. OWNER_ONLY in requestScope.ts already
  // refuses a member's POST here; the route refuses it too. Registered before
  // '/artist-genres/:key/undo' so 'vocabulary' is never read as an act's key.
  router.post('/artist-genres/vocabulary/csv/preview', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows must be an array.' });
    try {
      res.json({ preview: await previewGenreVocabCsv(deps.store, rows) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/artist-genres/vocabulary/csv/apply', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows must be an array.' });
    try {
      res.json(await applyGenreVocabCsv(deps.store, rows));
    } catch (err) {
      fail(res, err);
    }
  });

  // The genre links file (docs/specs/genre-taxonomy-phase-a.md section 5). Registered before '/artist-genres/:key/undo'.
  router.post('/artist-genres/relations/csv/preview', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows must be an array.' });
    try {
      res.json({ preview: await previewGenreRelationsCsv(deps.store, rows) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/artist-genres/relations/csv/apply', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows must be an array.' });
    try {
      res.json(await applyGenreRelationsCsv(deps.store, rows));
    } catch (err) {
      fail(res, err);
    }
  });

  // The bill links job (genre taxonomy release 3, section 7). Preview changes nothing; apply writes the links as one undoable change.
  router.post('/artist-genres/relations/lineup/preview', async (_req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    try {
      res.json({ preview: (await planLineupLinks(deps.store)).preview });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/artist-genres/relations/lineup/apply', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    try {
      res.json(await applyLineupLinks(deps.store));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/artist-genres/vocabulary/undo/:id', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    try {
      res.json({ change: await undoGenreVocabChange(deps.store, req.params.id, deps.now()) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/artist-genres/vocabulary/:operation', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: MEMBER_REFUSED });
    const op = Object.prototype.hasOwnProperty.call(VOCAB_WRITES, req.params.operation) ? VOCAB_WRITES[req.params.operation] : undefined;
    if (!op) return res.status(404).json({ error: 'No such genre operation.' });
    try {
      const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      res.json(await op(deps.store, b));
    } catch (err) {
      fail(res, err);
    }
  });

  // Genres for one act: { styles: [...] }, or { reset: true } to drop them.
  // The owner sets the shared genres (logged); a member sets only their own
  // additions, shown only to them.
  router.put('/artist-genres/:key', async (req, res) => {
    try {
      const set = isMember() ? setMemberAdditions : setOwnerGenres;
      res.json({ row: await set(deps.store, req.params.key, req.body?.styles, deps.now(), req.body?.reset === true) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Undoes the newest change to one act's shared genres (owner only, via
  // OWNER_ONLY). Returns that act's rows after the undo; 409 when the row
  // was changed since.
  router.post('/artist-genres/:key/undo', async (req, res) => {
    try {
      const key = req.params.key;
      const { restored } = await undoGenreChange(deps.store, key, deps.now());
      const rows = (await deps.store.listArtistGenres()).filter((r) => r.key === key);
      res.json({ restored, rows });
    } catch (err) {
      if (err instanceof InputError && /^Changed since/.test(err.message)) return res.status(409).json({ error: err.message });
      fail(res, err);
    }
  });

  // Artist orbits (0064). The owner gets every orbit and the last ORBIT_CHANGES_LIMIT changes. A member gets the
  // orbits holding an act of their own (full roster) and no changes. Without migration 0064 the answer is no orbits.
  router.get('/artist-orbits', async (_req, res) => {
    try {
      const orbits = await deps.store.listArtistOrbits();
      if (isMember()) return res.json({ orbits: orbitsForMember(orbits, await memberActKeys(deps.store)) });
      const changes = await deps.store.listOrbitChanges({ limit: ORBIT_CHANGES_LIMIT });
      res.json({ orbits, changes });
    } catch (err) {
      if (isMissingOrbitFunction(err)) return res.json({ orbits: [] });
      if (err instanceof ArtistOrbitError) return res.status(err.status).json({ error: err.message });
      fail(res, err);
    }
  });

  // Undoes one orbit change, owner only. Refused here for a member, as the other owner writes are.
  router.post('/artist-orbits/undo/:id', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: ORBIT_MEMBER_REFUSED });
    try {
      const change = await deps.store.undoOrbitChange(req.params.id, 'owner');
      res.json({ change });
    } catch (err) {
      if (err instanceof ArtistOrbitError) return res.status(err.status).json({ error: err.message });
      fail(res, err);
    }
  });

  // The orbits as a CSV (owner only). The file replaces the whole orbit set (docs/specs/genre-taxonomy-release-3.md section 4).
  router.get('/artist-orbits/csv', async (_req, res) => {
    if (isMember()) return res.status(403).json({ error: ORBIT_MEMBER_REFUSED });
    try {
      const day = deps.now().toISOString().slice(0, 10);
      res.setHeader('Content-Disposition', `attachment; filename="artist-orbits-${day}.csv"`);
      res.type('text/csv; charset=utf-8').send(await exportArtistOrbitsCsv(deps.store));
    } catch (err) {
      if (err instanceof ArtistOrbitError) return res.status(err.status).json({ error: err.message });
      fail(res, err);
    }
  });

  // Checks an uploaded orbits file. Changes nothing.
  router.post('/artist-orbits/csv/preview', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: ORBIT_MEMBER_REFUSED });
    try {
      res.json(await previewArtistOrbitsCsv(deps.store, req.body?.csv));
    } catch (err) {
      if (err instanceof ArtistOrbitError) return res.status(err.status).json({ error: err.message });
      fail(res, err);
    }
  });

  // Replaces the orbit set with the file as one logged change. Refused while the preview has errors.
  router.post('/artist-orbits/csv/apply', async (req, res) => {
    if (isMember()) return res.status(403).json({ error: ORBIT_MEMBER_REFUSED });
    try {
      res.json(await applyArtistOrbitsCsv(deps.store, req.body?.csv));
    } catch (err) {
      if (err instanceof ArtistOrbitError) return res.status(err.status).json({ error: err.message });
      fail(res, err);
    }
  });

  // The lineup of one event and the genre rows of its acts (docs/archive/genre-taxonomy-release-2.md section 1). Reads only.
  // The store scopes the event (a member gets only their own) and the rows (a member's 'added' rows are theirs alone),
  // so the rows are filtered here to the acts on this lineup.
  router.get('/events/:id/lineup-genres', async (req, res) => {
    try {
      const event = await deps.store.getEvent(req.params.id);
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      const job = event.lineupJobId ? await deps.store.getJob(event.lineupJobId) : null;
      const edition = event.editionId ? await deps.store.getEdition(event.editionId) : null;
      const acts = lineupActs(event, job, edition);
      const keys = new Set(acts.map((a) => a.key));
      const genres = keys.size ? (await deps.store.listArtistGenres()).filter((r) => keys.has(r.key)) : [];
      res.json({ acts, genres });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
