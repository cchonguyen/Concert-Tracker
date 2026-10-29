import { Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { JobRunner } from '../lineup/service';
import { DetailFinder, defaultFinders, pickCandidate, researchEvent } from './details';
import { geminiReader } from './detailsGemini';
import { cityPoint, citySuggestions, placeGuess } from './place';
import { applyPatch, EventPatch, lineupSummary, newEvent, sortEvents, startBulkLookups, startLineupLookup } from './service';
import { LineupSummary } from './types';
import { artistSuggestions, eventPerformers, nameArtistSuggestions, pastArtists, MAX_BULK_SUGGESTIONS, storedNameSuggestions } from './artists';
import type { LineupFacts } from './scale';
import { lookupWeather } from './weather';
import { undoActivity } from './undo';

// /api/events: your event log. Stage 1 is capture plus details research;
// stage 2 starts a lineup lookup from a saved event.
export function eventsRouter(deps: PipelineDeps, runner: JobRunner, finders: DetailFinder[] = defaultFinders()): Router {
  const router = Router();
  const fail = (res: any, err: unknown) =>
    res.status(err instanceof InputError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  const load = async (id: string, res: any) => {
    const event = await deps.store.getEvent(id);
    if (!event) res.status(404).json({ error: 'Event not found.' });
    return event;
  };

  router.get('/events', async (_req, res) => {
    try {
      const events = sortEvents(await deps.store.listEvents());
      const jobs = await deps.store.getJobs(events.map((e) => e.lineupJobId).filter((id): id is string => Boolean(id)));
      const lineups: Record<string, LineupSummary> = {};
      for (const job of jobs) if (job.eventId) lineups[job.eventId] = lineupSummary(job);
      // Size of each confirmed lineup, for Concert or Festival.
      const byEdition = await deps.store.editionLineupFacts([
        ...new Set(events.map((e) => e.editionId).filter((id): id is string => Boolean(id))),
      ]);
      const editions: Record<string, LineupFacts> = {};
      for (const e of events) if (e.editionId && byEdition[e.editionId]) editions[e.id] = byEdition[e.editionId];
      res.json({ events, lineups, editions });
    } catch (err) {
      fail(res, err);
    }
  });

  // Saves at once; the client then asks for details research.
  router.post('/events', async (req, res) => {
    try {
      const event = newEvent(String(req.body?.text ?? ''), deps.now());
      await deps.store.putEvent(event);
      res.status(201).json({ event });
    } catch (err) {
      fail(res, err);
    }
  });

  // Recently deleted shows, kept 90 days. Listed before /events/:id so "deleted" is not read as an id.
  router.get('/events/deleted', async (_req, res) => {
    try {
      res.json({ events: await deps.store.listDeletedEvents() });
    } catch (err) {
      fail(res, err);
    }
  });

  // Undo one Log row. 409 says why it was left alone, so the Log can tell you.
  router.post('/activity/:id/undo', async (req, res) => {
    try {
      const out = await undoActivity(deps.store, req.params.id);
      if (out.ok) return res.status(204).end();
      res.status(out.reason === 'not-found' ? 404 : 409).json({ error: out.reason });
    } catch (err) {
      fail(res, err);
    }
  });

  // The Log: every save, delete and restore, newest first. Kept one year.
  router.get('/activity', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      res.json({ activity: await deps.store.listActivity(limit) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Delete permanently: only a show already in Recently deleted can be erased.
  router.post('/events/:id/erase', async (req, res) => {
    try {
      const erased = await deps.store.eraseDeletedEvent(req.params.id);
      if (!erased) return res.status(404).json({ error: 'Not in Recently deleted.' });
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/events/trash/empty', async (_req, res) => {
    try {
      res.json({ removed: await deps.store.emptyTrash() });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/events/:id/restore', async (req, res) => {
    try {
      const restored = await deps.store.restoreEvent(req.params.id);
      if (!restored) return res.status(404).json({ error: 'Not in Recently deleted.' });
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/events/:id', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      const job = event.lineupJobId ? await deps.store.getJob(event.lineupJobId) : null;
      const edition = event.editionId ? await deps.store.getEdition(event.editionId) : null;
      const others = await deps.store.listEvents();
      const suggestions = artistSuggestions(event, [...eventPerformers(event, job, edition), ...pastArtists(others, event)]);
      res.json({ event, job, edition, suggestions });
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/events/:id', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      const updated = applyPatch(event, (req.body ?? {}) as EventPatch, deps.now());
      await deps.store.putEvent(updated);
      res.json({ event: updated });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/events/:id', async (req, res) => {
    try {
      await deps.store.deleteEvent(req.params.id);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // Stage 1 research: structured sources and search results read in code,
  // finished within the request. { useGemini: true } (you chose "Look again
  // with Gemini") also has Gemini read the pages found.
  router.post('/events/:id/details', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      let reader;
      if (req.body?.useGemini === true) {
        if (!deps.gemini || !deps.quota) throw new InputError('Gemini is not set up on this server.');
        reader = geminiReader(deps.gemini, deps.quota, deps.now);
      }
      const updated = await researchEvent(event, finders, deps.fetcher, deps.now(), reader);
      await deps.store.putEvent(updated);
      res.json({ event: updated });
    } catch (err) {
      fail(res, err);
    }
  });

  // Pick a suggestion ({ candidateId }), take some of its fields
  // ({ candidateId, fields }), or dismiss them all ({}).
  router.post('/events/:id/details/pick', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      const fields = Array.isArray(req.body?.fields) ? req.body.fields : undefined;
      const updated = pickCandidate(event, req.body?.candidateId, deps.now(), fields);
      await deps.store.putEvent(updated);
      res.json({ event: updated });
    } catch (err) {
      fail(res, err);
    }
  });

  // The weather on the event's days, when you ask. Returns { event, note }:
  // the event gains weather only when the archive had it.
  router.post('/events/:id/weather', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      const { weather, note } = await lookupWeather(event, deps.fetcher, deps.now());
      if (!weather) return res.json({ event, note });
      const updated = { ...event, weather, updatedAt: deps.now().toISOString() };
      await deps.store.putEvent(updated);
      res.json({ event: updated });
    } catch (err) {
      fail(res, err);
    }
  });

  // City suggestions as you type ("Las Vegas, NV").
  router.get('/places/cities', async (req, res) => {
    try {
      res.json({ cities: await citySuggestions(String(req.query.q ?? ''), deps.fetcher) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Where a city you stored is, for the map (?city=Las Vegas, NV&country=).
  router.get('/places/point', async (req, res) => {
    try {
      const city = String(req.query.city ?? '').slice(0, 200);
      const country = req.query.country ? String(req.query.country).slice(0, 100) : undefined;
      res.json({ point: await cityPoint(city, country, deps.fetcher) });
    } catch (err) {
      fail(res, err);
    }
  });

  // The state and country a stored city is in, offered for one tap
  // (?city=Las Vegas&region=&country=). Never saved here.
  router.get('/places/guess', async (req, res) => {
    try {
      const q = (k: string, max: number) => (req.query[k] ? String(req.query[k]).slice(0, max) : undefined);
      res.json(await placeGuess({ city: q('city', 200) ?? '', region: q('region', 100), country: q('country', 100) }, deps.fetcher));
    } catch (err) {
      fail(res, err);
    }
  });

  // Parts of the event's name that MusicBrainz knows as artists, offered as
  // one tap. Separate from GET /events/:id because it waits on MusicBrainz.
  router.get('/events/:id/name-artists', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      res.json({ suggestions: await nameArtistSuggestions(event, deps.fetcher) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Name suggestions for many events ({ ids }), from stored data only.
  router.post('/events/name-artists', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      if (ids.length > MAX_BULK_SUGGESTIONS) throw new InputError(`At most ${MAX_BULK_SUGGESTIONS} events at a time.`);
      res.json({ suggestions: await storedNameSuggestions(deps.store, ids) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Stage 2 for several events at once ({ ids }), from the Table. Queued only;
  // the worker (or the Cloudflare cron) drains them one at a time.
  router.post('/events/lineups', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      res.status(201).json(await startBulkLookups(deps, ids));
    } catch (err) {
      fail(res, err);
    }
  });

  // Stage 2: find who played. Optional { lineupUrl } points at a known page.
  router.post('/events/:id/lineup', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      const result = await startLineupLookup(deps, event, req.body?.lineupUrl);
      if (result.job.status === 'queued') await runner.kick(result.job.id);
      res.status(201).json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
