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

const isMember = () => currentMember()?.role === 'member';

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
    res.status(err instanceof InputError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });

  router.get('/artist-genres', async (_req, res) => {
    try {
      const [genres, map, csvUndo] = await Promise.all([
        visibleGenres(deps.store),
        deps.store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
        isMember() ? null : genresCsvUndoStatus(deps.store),
      ]);
      res.json({ genres, hasMap: Boolean(map?.length), known: knownGenres(map ?? [], genres), csvUndo });
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

  return router;
}
