import { Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { currentMember } from '../auth/requestScope';
import type { LineupStore } from '../lineup/store/types';
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
import { genreCollisions } from './genreVocabulary';
import type { GenreVocabulary } from './genreTypes';
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
import { applyGenreRelationsCsv, previewGenreRelationsCsv } from './genreRelationsCsv';
import { ManageError } from '../entities/manage';
import { eventPerformers } from './artists';
import { normalizeName } from '../lineup/text';
import type { Edition, LookupJob } from '../lineup/types';
import type { LoggedEvent } from './types';

// One act on an event's lineup: its key and name, and what the lineup says about where and when it plays.
export interface LineupGenresAct {
  key: string;
  name: string;
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
    if (p.status !== 'cancelled') note(p.name, { stages: p.stages ?? [], days: p.days ?? [], status: p.status, slotId: p.slotId });
  }
  for (const p of job?.candidate?.performers ?? []) {
    note(p.name, { stages: p.stages ?? [], days: p.days ?? [], status: p.status, slotId: p.slotId });
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
    out.push({ key, name: p.name, stages: i?.stages ?? [], days: i?.days ?? [], ...(i?.status ? { status: i.status } : {}), ...(i?.slotId ? { slotId: i.slotId } : {}) });
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
async function visibleGenres(store: LineupStore): Promise<ArtistGenres[]> {
  const rows = await store.listArtistGenres();
  if (!isMember()) return rows;
  const [events, entities] = await Promise.all([store.listEvents(), store.listEntities()]);
  const keys = new Set<string>(events.flatMap((e) => e.seen.map((s) => s.key)));
  for (const e of entities) if (e.kind === 'artist' && !e.mergedIntoId) keys.add(e.nameNormalized);
  return rows.filter((r) => r.source === 'added' || keys.has(r.key));
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
  // additions never reach either (docs/specs/genre-vocabulary.md section 8).
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

  // The downloadable CSV of the acts you can give genres (see docs/specs/genres-csv.md).
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

  // The lineup of one event and the genre rows of its acts (docs/specs/genre-taxonomy-release-2.md section 1). Reads only.
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
