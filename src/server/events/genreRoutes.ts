import { Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { GENRE_MAP_SETTING, GenreMapEntry, importMusicStory, knownGenres, musicBrainzGenres, setOwnGenres } from './genres';

// /api/artist-genres: genres of the acts you saw (see ARCHITECTURE.md, Artist genres).
export function genresRouter(deps: PipelineDeps): Router {
  const router = Router();
  const fail = (res: any, err: unknown) =>
    res.status(err instanceof InputError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });

  router.get('/artist-genres', async (_req, res) => {
    try {
      const [genres, map] = await Promise.all([
        deps.store.listArtistGenres(),
        deps.store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
      ]);
      res.json({ genres, hasMap: Boolean(map?.length), known: knownGenres(map ?? [], genres) });
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
