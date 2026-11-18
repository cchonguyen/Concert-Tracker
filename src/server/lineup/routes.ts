import { Router } from 'express';
import { createLookup, enqueueArtistResolution, InputError, PipelineDeps, requeueFailedResolveArtists } from './pipeline';
import { confirmLookup, confirmLookupForMember, ConfirmRequest } from './learning';
import { currentMember } from '../auth/requestScope';
import { isOwner } from '../entities/canonicalManage';
import { configuredSources, JobRunner } from './service';
import { redactSecrets } from './http';
import { LookupJob } from './types';
import { readReaderConfig } from '../reader/config';
import { BREAKER_KEY, callsMonthKey, dayKey, monthKey } from '../reader/guard';
import { EditionOccurrenceConflictError, isEditionSuggestQuery } from './store/types';
import { canonReviewRouter } from '../canon/reviewRoutes';
import { finderReadout } from '../telemetry/finderReadout';
import { clashfinderCandidates } from './adapters/clashfinder';
import { findLineupRequest } from './canonicalIngest';
import { refreshEditionWeather } from '../events/editionWeather';

// Older log entries were written before redaction existed.
const safeJob = (job: LookupJob): LookupJob => ({
  ...job,
  lastError: job.lastError && redactSecrets(job.lastError),
  log: job.log.map((e) => ({ ...e, message: redactSecrets(e.message) })),
});

// Owner view of the reader (docs/ai-reader-spec.md "Owner view"). Counts, sizes and codes only:
// never page text, prompts, quotes or names. Members get the summary without spend, caps, log or recent.
export async function readerStatus(deps: PipelineDeps, owner: boolean, env: Record<string, unknown> = process.env) {
  const reader = deps.reader;
  if (!reader) return null;
  const now = deps.now();
  const config = readReaderConfig(env);
  const used = async (key: string): Promise<number> => {
    try {
      return (await deps.store.getQuota(key))?.used ?? 0;
    } catch {
      return 0;
    }
  };
  let breaker: { open: boolean; until?: string; failures: number } = { open: false, failures: 0 };
  try {
    const b = await deps.store.getQuota(BREAKER_KEY);
    const open = Boolean(b?.exhaustedUntil && new Date(b.exhaustedUntil) > now);
    breaker = { open, ...(open ? { until: b!.exhaustedUntil } : {}), failures: b?.used ?? 0 };
  } catch {
    // unreadable: report closed
  }
  const callsToday = deps.quota ? (await deps.quota.status(now).catch(() => null))?.used ?? 0 : 0;
  const base = {
    provider: reader.provider,
    model: reader.model,
    thinkingLevel: config.thinkingLevel,
    enabled: config.enabled,
    breaker,
    callsToday,
    callsMonth: await used(callsMonthKey(now)),
  };
  if (!owner) return base;
  let recent: Array<Record<string, unknown>> = [];
  try {
    recent = (await deps.store.listAiCalls(20)).map((r) => ({
      createdAt: r.createdAt,
      feature: r.feature,
      provider: r.provider,
      model: r.model,
      outcome: r.outcome,
      reason: r.guardReason ?? r.errorCode ?? null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      estCostUsd: r.estCostUsd,
    }));
  } catch {
    // the log table may be missing; the guards do not depend on it
  }
  return {
    ...base,
    spendTodayUsd: (await used(dayKey(now))) / 1_000_000,
    spendMonthUsd: (await used(monthKey(now))) / 1_000_000,
    caps: {
      dayUsd: config.maxSpendDayUsd,
      monthUsd: config.maxSpendMonthUsd,
      perJob: config.maxCallsPerJob,
      inputChars: config.maxInputChars,
      outputTokens: config.maxOutputTokens,
    },
    logWriteFailuresToday: await used(`reader:logfail:${now.toISOString().slice(0, 10)}`),
    recent,
  };
}

export function lineupRouter(deps: PipelineDeps, runner: JobRunner): Router {
  const router = Router();
  const fail = (res: any, err: unknown, status = 500) =>
    res.status(err instanceof InputError ? 400 : status).json({ error: err instanceof Error ? err.message : String(err) });

  router.get('/lineup/status', async (_req, res) => {
    try {
      const reader = await readerStatus(deps, isOwner(currentMember()));
      res.json({ ...configuredSources(deps), quota: deps.quota ? await deps.quota.status() : null, ...(reader ? { reader } : {}) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Owner only (Stage 1.2): per-finder runs, hits and timings for research over the last 30 days.
  router.get('/lineup/finder-readout', async (_req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      const traces = await deps.store.listIngestTraces(2000);
      res.json({ days: 30, finders: finderReadout(traces, deps.now()) });
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

  // The owner's canonical ingest queue: recent jobs with no saved event, newest first.
  // Owner only; members never see the archive.
  router.get('/manage/canonical/lookups', async (_req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      const jobs = await deps.store.listCanonicalJobs(30);
      res.json({ jobs: jobs.map(safeJob) });
    } catch (err) {
      fail(res, err);
    }
  });

  // One-time repair (slice 11.7): artist-resolution jobs that failed on a MusicBrainz 503 go back to waiting.
  // Owner only and idempotent: a job already re-queued once is skipped.
  router.post('/manage/requeue-resolve-artists', async (_req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      const ids = await requeueFailedResolveArtists(deps);
      res.json({ requeued: ids.length, ids });
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

  // Clashfinder "Find lineup" on one festival edition (slice 2.10). Owner only. Starts the same owner lookup as
  // the ingest route, with no event attached, so the result goes to Lookups for review.
  router.post('/manage/canonical/editions/:id/find-lineup', async (req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      const edition = await deps.store.getEdition(req.params.id);
      const series = edition?.seriesSlug ? await deps.store.getSeries(edition.seriesSlug) : null;
      const request = findLineupRequest(edition, series?.clashfinderSlugs?.[String(edition?.year)] ?? null);
      if (!request.ok) return res.status(edition ? 400 : 404).json({ error: request.error });
      const { ok: _ok, ...input } = request;
      const job = await createLookup(deps, input);
      await runner.kick(job.id, true);
      res.status(201).json({ job: safeJob(job) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Canonical ingest: every Clashfinder version that matches a name and year, for
  // the Lineup URL field. Owner only; nothing is saved.
  router.get('/manage/canonical/versions', async (req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
      const year = Number(req.query.year);
      if (!name || !Number.isInteger(year)) throw new InputError('Enter the name and a four-digit year first.');
      res.json({ versions: await clashfinderCandidates(deps.fetcher, { eventName: name, year }) });
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
      if (err instanceof EditionOccurrenceConflictError || (err instanceof Error && err.name === 'EditionOccurrenceConflictError')) {
        const conflictingEdition = (err as EditionOccurrenceConflictError).conflictingEdition;
        return res.status(409).json({ error: err.message, ...(conflictingEdition ? { conflictingEdition } : {}) });
      }
      fail(res, err, 400);
    }
  });

  router.get('/editions', async (_req, res) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      res.json({ editions: await deps.store.listEditions(100) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Canonical edition suggestions for the capture bar (slice 9.1). Any signed-in member. Editions linked to
  // the caller's live events are left out; deleted events are not in listEvents(), so they do not hide one.
  router.get('/editions/suggest', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      if (!isEditionSuggestQuery(q)) return res.json({ editions: [] });
      const live = await deps.store.listEvents();
      const excludeIds = [...new Set(live.map((e) => e.editionId).filter((id): id is string => Boolean(id)))];
      const loggedWeekendsByEdition: Record<string, Array<number | null>> = {};
      for (const e of live) {
        if (!e.editionId) continue;
        (loggedWeekendsByEdition[e.editionId] ??= []).push(e.weekend ?? null);
      }
      res.json({ editions: await deps.store.suggestEditions(q, { excludeIds, limit: 5, loggedWeekendsByEdition }) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Slice 4 (canonical weather): the owner refreshes an edition's weather record. The change is in the
  // edition history, so it can be undone there.
  router.post('/canon/editions/:id/weather/refresh', async (req, res) => {
    try {
      if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.params.id)) return res.status(400).json({ error: 'That is not a valid edition id.' });
      const edition = await deps.store.getEdition(req.params.id);
      if (!edition) return res.status(404).json({ error: 'No such edition.' });
      res.json(await refreshEditionWeather(deps.store, edition, deps.fetcher, deps.now(), 'owner'));
    } catch (err) {
      fail(res, err);
    }
  });

  router.use(canonReviewRouter(deps.store));

  return router;
}
