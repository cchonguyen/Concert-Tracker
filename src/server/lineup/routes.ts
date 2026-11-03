import { Router } from 'express';
import { createLookup, enqueueArtistResolution, InputError, PipelineDeps } from './pipeline';
import { confirmLookup, confirmLookupForMember, ConfirmRequest } from './learning';
import { currentMember } from '../auth/requestScope';
import { isOwner } from '../entities/canonicalManage';
import { configuredSources, JobRunner } from './service';
import { redactSecrets } from './http';
import { LookupJob } from './types';

// Older log entries were written before redaction existed.
const safeJob = (job: LookupJob): LookupJob => ({
  ...job,
  lastError: job.lastError && redactSecrets(job.lastError),
  log: job.log.map((e) => ({ ...e, message: redactSecrets(e.message) })),
});

export function lineupRouter(deps: PipelineDeps, runner: JobRunner): Router {
  const router = Router();
  const fail = (res: any, err: unknown, status = 500) =>
    res.status(err instanceof InputError ? 400 : status).json({ error: err instanceof Error ? err.message : String(err) });

  router.get('/lineup/status', async (_req, res) => {
    try {
      res.json({ ...configuredSources(deps), quota: deps.quota ? await deps.quota.status() : null });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/lookups', async (_req, res) => {
    try {
      const jobs = await deps.store.listJobs(30);
      res.json({ jobs: jobs.filter((j) => j.kind === 'lineup').map(safeJob) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Lookups with no saved event are the owner's canonical ingest (Phase 2b). Members use /events/:id/lineup.
  router.post('/lookups', async (req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      const job = await createLookup(deps, req.body ?? {});
      if (job.status === 'queued') await runner.kick(job.id);
      res.status(201).json({ job });
    } catch (err) {
      fail(res, err);
    }
  });

  // Canonical ingest (Phase 2b): a lookup for an edition with no saved event.
  // Owner only. The job has no eventId, so confirming it writes only the shared
  // catalog (POST /api/manage/canonical/confirm), never a personal log.
  router.post('/manage/canonical/ingest', async (req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      const { name, year, startDate, endDate, venue, city, country, lineupUrl } = (req.body ?? {}) as Record<string, unknown>;
      const job = await createLookup(deps, {
        eventName: name as string,
        year: year as number,
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
        venue: venue as string | undefined,
        city: city as string | undefined,
        country: country as string | undefined,
        lineupUrl: lineupUrl as string | undefined,
      });
      if (job.status === 'queued') await runner.kick(job.id);
      res.status(201).json({ job: safeJob(job) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/lookups/:id', async (req, res) => {
    try {
      const job = await deps.store.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Lookup not found.' });
      res.json({ job: safeJob(job) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Retry now, e.g. after quota came back early. A job still out of quota
  // simply parks again.
  router.post('/lookups/:id/run', async (req, res) => {
    try {
      const job = await deps.store.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Lookup not found.' });
      // A lookup with no saved event feeds the shared catalog: only the owner may run it.
      if (!job.eventId && !isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
      await runner.kick(job.id, true);
      res.json({ job: safeJob(job) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/lookups/:id/confirm', async (req, res) => {
    try {
      const job = await deps.store.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Lookup not found.' });
      if (!job.eventId && !isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
      // A member's review changes only their own event; the owner's writes the shared lineup.
      if (currentMember()?.role === 'member') return res.json(await confirmLookupForMember(deps.store, job, req.body as ConfirmRequest));
      const result = await confirmLookup(deps.store, job, req.body as ConfirmRequest);
      if ((await deps.store.listUnresolvedArtists(1)).length) await enqueueArtistResolution(deps);
      res.json(result);
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.get('/editions', async (_req, res) => {
    try {
      res.json({ editions: await deps.store.listEditions(100) });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
