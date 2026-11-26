import { Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { GENRE_MAP_SETTING, GenreMapEntry, importMusicStory, knownGenres, musicBrainzGenres, setOwnGenres } from './genres';
import {
  applyGenresCsv,
  exportGenresCsv,
  genresCsvUndoStatus,
  previewGenresCsv,
  undoGenresCsv,
} from './genreCsvApply';

// /api/artist-genres: genres of the acts you saw (see ARCHITECTURE.md, Artist genres).
export function genresRouter(deps: PipelineDeps): Router {
  const router = Router();
  const fail = (res: any, err: unknown) =>
    res.status(err instanceof InputError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });

  router.get('/artist-genres', async (_req, res) => {
    try {
      const [genres, map, csvUndo] = await Promise.all([
        deps.store.listArtistGenres(),
        deps.store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
        genresCsvUndoStatus(deps.store),
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

  // Your own genres for one act you saw: { styles: [...] }, or { reset: true }
  // to drop them so the found ones show again.
  router.put('/artist-genres/:key', async (req, res) => {
    try {
      res.json({ row: await setOwnGenres(deps.store, req.params.key, req.body?.styles, deps.now(), req.body?.reset === true) });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
