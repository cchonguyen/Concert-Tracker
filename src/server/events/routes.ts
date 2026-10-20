import { Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { JobRunner } from '../lineup/service';
import { DetailFinder, defaultFinders, pickCandidate, researchEvent } from './details';
import { citySuggestions } from './place';
import { applyPatch, EventPatch, lineupSummary, newEvent, sortEvents, startLineupLookup } from './service';
import { LineupSummary } from './types';

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
      res.json({ events, lineups });
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

  router.get('/events/:id', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      const job = event.lineupJobId ? await deps.store.getJob(event.lineupJobId) : null;
      const edition = event.editionId ? await deps.store.getEdition(event.editionId) : null;
      res.json({ event, job, edition });
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

  // Stage 1 research: structured sources only, finished within the request.
  router.post('/events/:id/details', async (req, res) => {
    try {
      const event = await load(req.params.id, res);
      if (!event) return;
      const updated = await researchEvent(event, finders, deps.fetcher, deps.now());
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

  // City suggestions as you type ("Las Vegas, NV").
  router.get('/places/cities', async (req, res) => {
    try {
      res.json({ cities: await citySuggestions(String(req.query.q ?? ''), deps.fetcher) });
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
