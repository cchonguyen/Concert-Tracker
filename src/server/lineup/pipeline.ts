import { yourSpellings } from './actName';
import { randomUUID } from 'node:crypto';
import {
  AdapterResult,
  CandidateLineup,
  Edition,
  Fetcher,
  JobLogEntry,
  LookupInput,
  LookupJob,
  PerformerClaim,
  SeriesRecord,
  SourceAdapter,
} from './types';
import { isStaleRun, LineupStore } from './store/types';
import { GeminiClient, EXTRACTION_PROMPT_VERSION } from './gemini';
import { QuotaExhaustedError, QuotaLedger } from './quota';
import { appendFacts, mergeLineup } from './merge';
import { domainOf, editionKeyFor, htmlToText, isVerbatim, normalizeName, seriesSlugFor } from './text';
import { findVerifiedEdition } from '../canon/match';
import { isBilling,quoteBacksBilling } from './billing';
import { makeDocument } from './adapters/common';
import { MusicBrainzUnavailableError, resolveArtist } from './musicbrainz';
import { redactSecrets } from './http';
import { currentBudget } from './budget';
import { isReaderExtractor } from './learning';
import { isEventDomain, LineupSearch, pageMentionsEvent } from './search';

import type { GuardedReader } from '../reader/guardedReader';

export interface PipelineDeps {
  store: LineupStore;
  fetcher: Fetcher;
  // First wave runs in parallel; the second wave sees facts from the first
  // (setlist.fm needs dates and a city).
  adapters: SourceAdapter[];
  lateAdapters: SourceAdapter[];
  gemini: GeminiClient | null;
  quota: QuotaLedger | null;
  // Web search for lineup pages, used only when every source came back empty.
  search: LineupSearch | null;
  now: () => Date;
  // Guarded reader (src/server/reader): the only way the pipeline reads a page or searches with a model.
  reader?: GuardedReader | null;
  // Multi-user only: false for a member who is blocked or removed. Their jobs are parked, with no outside call.
  hasActiveUser?: (userId: string) => Promise<boolean>;
}

const MAX_ATTEMPTS = 3;
// Two subrequests per artist (MusicBrainz, then the store) plus the job's own
// reads and writes must stay under the Workers limit of 50 per invocation.
const ARTISTS_PER_RESOLVE_RUN = 20;
// Stage 2 gates (code, no heuristics): Clashfinder with this many acts is the lineup; the reader
// is used for a page only when the non-model sources gave fewer than STRUCTURED_ENOUGH acts.
const CLASHFINDER_ENOUGH = 5;
const STRUCTURED_ENOUGH = 2;

export class InputError extends Error {}

export function validateInput(raw: Partial<LookupInput>): LookupInput {
  const eventName = (raw.eventName ?? '').trim();
  const year = Number(raw.year);
  if (!eventName) throw new InputError('Event name is required.');
  if (!Number.isInteger(year) || year < 1950 || year > 2100) throw new InputError('A four-digit year is required.');
  const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined);
  const text = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  return {
    eventName,
    year,
    startDate: date(raw.startDate),
    endDate: date(raw.endDate),
    venue: text(raw.venue),
    city: text(raw.city),
    country: text(raw.country),
    lineupUrl: text(raw.lineupUrl),
    notes: text(raw.notes),
  };
}

function log(job: LookupJob, message: string, now: Date): void {
  const entry: JobLogEntry = { at: now.toISOString(), message: redactSecrets(message) };
  job.log = [...job.log, entry].slice(-100);
}

export function candidateFromEdition(edition: Edition): CandidateLineup {
  return {
    editionKey: edition.key,
    cached: true,
    facts: {
      name: edition.name,
      startDate: edition.startDate,
      endDate: edition.endDate,
      venue: edition.venue,
      city: edition.city,
      country: edition.country,
      sources: {},
    },
    performers: edition.performances
      .filter((p) => p.status !== 'cancelled')
      .map((p) => ({
        key: p.artistKey,
        slotId: p.slotId,
        alias: p.alias,
        b2b: p.b2b,
        name: p.name,
        days: p.days,
        stages: p.stages,
        status: p.status === 'performed' ? 'performed' : 'billed',
        billing: p.billing,
        confidence: p.confidence,
        flagged: false,
        sources: p.sources,
      })),
    droppedCount: 0,
  };
}

// A verified edition for this event, found by the shared matcher (date and subject), not by key.
async function findConfirmedEdition(deps: PipelineDeps, input: LookupInput): Promise<Edition | null> {
  return findVerifiedEdition(deps.store, input);
}

export async function createLookup(
  deps: PipelineDeps,
  raw: Partial<LookupInput>,
  opts: { eventId?: string } = {},
): Promise<LookupJob> {
  const input = validateInput(raw);
  const now = deps.now();
  const cached = await findConfirmedEdition(deps, input);
  const editionKey = cached?.key ?? editionKeyFor(input.eventName, input.year, input.startDate);
  const job: LookupJob = {
    id: randomUUID(),
    kind: 'lineup',
    input,
    editionKey,
    status: 'queued',
    stage: 'collect',
    attempts: 0,
    pendingExtraction: [],
    discoveryDone: false,
    facts: {},
    eventId: opts.eventId,
    log: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (cached) {
    job.status = 'needs_review';
    job.stage = 'done';
    job.editionId = cached.id;
    job.candidate = candidateFromEdition(cached);
    log(job, `Found a confirmed lineup for ${editionKey} in the database; no lookups needed.`, now);
  } else {
    log(job, `Queued lookup for ${editionKey}.`, now);
  }
  await deps.store.createJob(job);
  return job;
}

async function persistAdapterResult(
  deps: PipelineDeps,
  job: LookupJob,
  result: AdapterResult,
  now: Date,
): Promise<{ claims: PerformerClaim[]; extraction: string[] }> {
  // putDocument may return an existing document, so remap ids.
  const idMap = new Map<string, string>();
  for (const doc of result.documents) {
    const stored = await deps.store.putDocument(doc);
    idMap.set(doc.id, stored.id);
  }
  const claims = result.performers.map(
    (p): PerformerClaim => ({
      ...p,
      id: randomUUID(),
      jobId: job.id,
      documentId: idMap.get(p.documentId) ?? p.documentId,
      createdAt: now.toISOString(),
    }),
  );
  await deps.store.addPerformerClaims(claims);
  return { claims, extraction: result.extractionQueue.map((id) => idMap.get(id) ?? id) };
}

async function runAdapters(
  deps: PipelineDeps,
  job: LookupJob,
  adapters: SourceAdapter[],
  input: LookupInput,
  series: SeriesRecord | null,
  now: Date,
): Promise<Partial<SeriesRecord>> {
  const enabled = adapters.filter((a) => a.enabled());
  const settled = await Promise.allSettled(
    enabled.map((a) =>
      a.collect({ input, editionKey: job.editionKey, series, now, fetcher: deps.fetcher }),
    ),
  );
  let hints: Partial<SeriesRecord> = {};
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      log(job, `${enabled[i].id} failed: ${msg}`, now);
      continue;
    }
    const { extraction } = await persistAdapterResult(deps, job, outcome.value, now);
    job.facts = appendFacts(job.facts, outcome.value.facts);
    job.pendingExtraction.push(...extraction);
    hints = { ...hints, ...outcome.value.seriesHints };
    for (const note of outcome.value.notes) log(job, note, now);
  }
  return hints;
}

async function stageCollect(deps: PipelineDeps, job: LookupJob, now: Date): Promise<void> {
  const slug = seriesSlugFor(job.input.eventName);
  const series = await deps.store.getSeries(slug);
  const disabled = [...deps.adapters, ...deps.lateAdapters].filter((a) => !a.enabled()).map((a) => a.id);
  if (disabled.length) log(job, `Not configured, skipped: ${disabled.join(', ')}.`, now);

  let hints = await runAdapters(deps, job, deps.adapters, job.input, series, now);

  const first = (k: 'startDate' | 'endDate' | 'city' | 'venue') => job.facts[k]?.[0]?.value;
  const enriched: LookupInput = {
    ...job.input,
    startDate: job.input.startDate ?? first('startDate'),
    endDate: job.input.endDate ?? first('endDate'),
    city: job.input.city ?? first('city'),
    venue: job.input.venue ?? first('venue'),
  };
  hints = { ...hints, ...(await runAdapters(deps, job, deps.lateAdapters, enriched, series, now)) };

  if (Object.keys(hints).length || !series) {
    await deps.store.upsertSeries({ ...(series ?? { slug, name: job.input.eventName }), ...hints, slug });
  }
  job.stage = 'extract';
}

async function stageExtract(deps: PipelineDeps, job: LookupJob, now: Date, force: boolean): Promise<void> {
  if (job.pendingExtraction.length > 0 && !deps.reader) {
    log(job, `Reader not configured, so ${job.pendingExtraction.length} page(s) could not be read.`, now);
    job.pendingExtraction = [];
  }
  const reader = deps.reader;
  // One page per call: runJob saves the job between pages, and a Worker runs
  // each page in its own invocation to stay under the subrequest limit.
  if (job.pendingExtraction.length > 0) {
    const docId = job.pendingExtraction[0];
    const doc = await deps.store.getDocument(docId);
    if (doc) {
      // A stored document keeps the type it was first saved with, so an event-site
      // page first found by search is recognised by its domain here too.
      const official = doc.sourceType !== 'discovered' || isEventDomain(doc.url, job.input.eventName);
      const sourceType = official && doc.sourceType === 'discovered' ? 'promoter' : doc.sourceType;
      const extractor = `${reader!.provider}:${reader!.model}`;
      // Gates: structured sources first. A skipped page costs no reader call and is not an error.
      const have = await deps.store.listPerformerClaims(job.id);
      const clashfinderActs = have.filter((c) => c.sourceType === 'clashfinder').length;
      const structuredActs = have.filter((c) => !isReaderExtractor(c.extractor)).length;
      const gate =
        clashfinderActs >= CLASHFINDER_ENOUGH
          ? `skipped: clashfinder_enough (Clashfinder gave ${clashfinderActs} acts)`
          : structuredActs >= STRUCTURED_ENOUGH
            ? `skipped: structured_enough (structured sources gave ${structuredActs} acts)`
            : null;
      if (gate) {
        log(job, `Not read by the AI reader, ${doc.url}: ${gate}.`, now);
        job.pendingExtraction = job.pendingExtraction.slice(1);
        return;
      }
      // Extraction cache: the same page (same content hash) already read for
      // this edition with this model and prompt gives the same names, so reuse
      // them instead of spending Gemini quota. Each is checked on the page again.
      const cached = await deps.store.findExtractedClaims({
        editionKey: job.editionKey,
        documentId: doc.id,
        extractor,
        extractorVersion: EXTRACTION_PROMPT_VERSION,
        excludeJobId: job.id,
      });
      if (cached.length > 0) {
        const normalized = normalizeName(doc.body);
        const reused = cached
          .filter((c) => isVerbatim(c.name, c.quotedSpan, normalized))
          .map((c): PerformerClaim => ({ ...c, id: randomUUID(), jobId: job.id, sourceType, createdAt: now.toISOString() }));
        await deps.store.addPerformerClaims(reused);
        log(job, `Read ${doc.url} from an earlier lookup of this edition: kept ${reused.length} name(s), no Gemini call.`, now);
        job.pendingExtraction = job.pendingExtraction.slice(1);
        return;
      }
      const examples = await deps.store.getExamples(domainOf(doc.url));
      const normalizedDoc = normalizeName(doc.body);
      // The whole page goes to the guarded reader; a page over the input ceiling is skipped there (input_too_large), never cut.
      const text = doc.body;
      const read = await reader!.extractPerformers(
        { text, input: job.input, examples },
        {
          feature: 'lineup_extract',
          jobKey: job.id,
          jobId: job.id,
          eventId: job.eventId,
          userId: job.userId,
          documentId: doc.id,
          force,
          afterRead: (list) => ({
            returned: list.length,
            verbatim: list.filter((e) => e?.name && e?.quote && isVerbatim(e.name, e.quote, normalizedDoc)).length,
          }),
        },
      );
      if (!read.ok) {
        // A dropped page is not an error: logged, never retried, the next page is read.
        log(job, `Skipped ${doc.url}: ${read.reason === 'input_too_large' ? 'skipped: input_too_large, the page is over the reader limit and is never cut up' : 'the reader gave an unusable answer'} (${read.reason}).`, now);
        job.pendingExtraction = job.pendingExtraction.slice(1);
        return;
      }
      const extracted = read.value;
      const kept: PerformerClaim[] = [];
      let rejected = 0;
      for (const e of extracted) {
        if (!e?.name || !e?.quote || !isVerbatim(e.name, e.quote, normalizedDoc)) {
          rejected += 1;
          continue;
        }
        kept.push({
          id: randomUUID(),
          jobId: job.id,
          documentId: doc.id,
          sourceType,
          sourceUrl: doc.url,
          name: e.name.trim(),
          quotedSpan: e.quote.trim(),
          evidence: 'billed',
          day: e.day && /^\d{4}-\d{2}-\d{2}$/.test(e.day) && normalizedDoc.includes(normalizeName(e.day)) ? e.day : undefined,
          stage: e.stage && normalizedDoc.includes(normalizeName(e.stage)) ? e.stage : undefined,
          billing: isBilling(e.billing) && quoteBacksBilling(e.quote, e.name, e.billing) ? e.billing : undefined,
          extractor,
          extractorVersion: EXTRACTION_PROMPT_VERSION,
          createdAt: now.toISOString(),
        });
      }
      await deps.store.addPerformerClaims(kept);
      log(job, `Read ${doc.url}: kept ${kept.length} name(s), rejected ${rejected} not found verbatim on the page.`, now);
    }
    job.pendingExtraction = job.pendingExtraction.slice(1);
    return;
  }

  const claims = await deps.store.listPerformerClaims(job.id);
  const canDiscover = deps.search && deps.reader && !job.discoveryDone;
  const isSparseFestival =
    Boolean(
      (job.input.endDate && job.input.endDate !== job.input.startDate) ||
        (job.facts.endDate && job.facts.startDate && job.facts.endDate[0]?.value !== job.facts.startDate[0]?.value),
    ) && claims.length < 5;
  const needsDiscovery = (claims.length === 0 || isSparseFestival) && canDiscover;
  job.stage = needsDiscovery ? 'discover' : 'merge';
}

const SEARCH_RESULTS_TO_TRY = 6;
const SEARCH_PAGES_TO_READ = 3;

async function stageDiscover(deps: PipelineDeps, job: LookupJob, now: Date, force: boolean): Promise<void> {
  // Search may have been switched off while this job was parked. Extraction
  // still needs Gemini, so search without it would only fetch pages.
  if (!deps.search || !deps.reader) {
    job.discoveryDone = true;
    job.stage = 'merge';
    log(job, deps.search ? 'Reader not configured; web search skipped.' : 'Web search is off; skipped.', now);
    return;
  }
  // Grounded Gemini search goes through the guarded reader (guards own quota); other providers do not spend it.
  const urls = deps.search.usesGeminiQuota
    ? await deps.reader.discoverLineupUrls(job.input, {
        feature: 'discovery',
        jobKey: job.id,
        jobId: job.id,
        eventId: job.eventId,
        userId: job.userId,
        force,
      })
    : await deps.search.findLineupUrls(job.input);
  job.discoveryDone = true;
  log(job, urls.length ? `Web search (${deps.search.id}) returned ${urls.length} result(s).` : `Web search (${deps.search.id}) found nothing.`, now);
  let read = 0;
  // The event's own site first: it is the most complete and reliable page.
  const ordered = [...urls.filter((u) => isEventDomain(u, job.input.eventName)), ...urls.filter((u) => !isEventDomain(u, job.input.eventName))];
  for (const url of ordered.slice(0, SEARCH_RESULTS_TO_TRY)) {
    if (read >= SEARCH_PAGES_TO_READ) break;
    try {
      const res = await deps.fetcher.get(url, { timeoutMs: 30000 });
      if (res.status !== 200) {
        log(job, `Could not fetch ${url} (HTTP ${res.status}).`, now);
        continue;
      }
      const text = htmlToText(res.body);
      if (!pageMentionsEvent(text, job.input)) {
        log(job, `Skipped ${url}: the page does not name ${job.input.eventName} and ${job.input.year}.`, now);
        continue;
      }
      const sourceType = isEventDomain(res.url, job.input.eventName) ? 'promoter' : 'discovered';
      const doc = await deps.store.putDocument(makeDocument(res.url, sourceType, text, 'text'));
      job.pendingExtraction.push(doc.id);
      read += 1;
    } catch (err) {
      log(job, `Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`, now);
    }
  }
  if (urls.length && !read) log(job, 'No search result was a page about this edition.', now);
  job.stage = 'extract';
}

async function stageMerge(deps: PipelineDeps, job: LookupJob, now: Date): Promise<void> {
  const slug = seriesSlugFor(job.input.eventName);
  const claims = await deps.store.listPerformerClaims(job.id);
  const domains = ['*', ...new Set(claims.map((c) => domainOf(c.sourceUrl)))];
  const series = await deps.store.getSeries(slug);
  job.candidate = mergeLineup({
    input: job.input,
    editionKey: job.editionKey,
    seriesSlug: slug,
    facts: job.facts,
    claims,
    aliases: await deps.store.getAliases(),
    blocklist: await deps.store.getBlocklist(domains),
    stats: await deps.store.getSourceStats(),
    priority: series?.sourcePriority,
    // Only the spellings of the member who started the lookup.
    spellings: yourSpellings(
      await (job.userId && deps.store.forUser ? deps.store.forUser({ userId: job.userId, role: 'member' }) : deps.store).listSeenArtistNames(),
    ),
  });
  job.stage = 'done';
  if (job.candidate.performers.length > 0) {
    job.status = 'needs_review';
    log(job, `Lineup ready for review: ${job.candidate.performers.length} act(s).`, now);
  } else {
    job.status = 'no_data';
    log(job, 'No source listed a lineup. Add a lineup URL or enter acts by hand.', now);
  }
}

// MusicBrainz outage backoff: 5 minutes after the first park, doubling for each
// consecutive park, capped at 6 hours. A Retry-After from a 429 is honored when longer.
const MB_PARK_BASE_MS = 5 * 60_000;
const MB_PARK_CAP_MS = 6 * 3_600_000;
const MB_PARK_PREFIX = 'MusicBrainz';

// Consecutive parks so far, read from the job log (no new column): parks since the last successful run.
function musicBrainzParks(job: LookupJob): number {
  let n = 0;
  for (let i = job.log.length - 1; i >= 0; i--) {
    const m = job.log[i].message;
    if (m.startsWith('Resolved ')) break;
    if (m.startsWith(`Paused: ${MB_PARK_PREFIX}`)) n++;
  }
  return n;
}

export function musicBrainzRetryAt(job: LookupJob, now: Date, retryAfterSeconds?: number): Date {
  const backoff = Math.min(MB_PARK_BASE_MS * 2 ** musicBrainzParks(job), MB_PARK_CAP_MS);
  const asked = retryAfterSeconds ? Math.min(retryAfterSeconds * 1000, MB_PARK_CAP_MS) : 0;
  return new Date(now.getTime() + Math.max(backoff, asked));
}

async function runResolveArtists(deps: PipelineDeps, job: LookupJob, now: Date): Promise<void> {
  const pending = await deps.store.listUnresolvedArtists(ARTISTS_PER_RESOLVE_RUN);
  let done = 0;
  for (const artist of pending) {
    try {
      await deps.store.upsertArtist(await resolveArtist(deps.fetcher, artist));
      done++;
    } catch (err) {
      if (!(err instanceof MusicBrainzUnavailableError)) throw err;
      // Artists already saved above stay saved. Park this job only; no other source is tried.
      throw new QuotaExhaustedError(
        musicBrainzRetryAt(job, now, err.retryAfterSeconds),
        `${err.message} Retrying later; ${done} artist ID(s) were saved this run.`,
        'job',
      );
    }
  }
  const remaining = await deps.store.listUnresolvedArtists(1);
  job.stage = remaining.length ? 'collect' : 'done';
  job.status = remaining.length ? 'queued' : 'confirmed';
  log(job, `Resolved ${pending.length} artist ID(s) with MusicBrainz.`, now);
}

// The Cron Trigger fires every minute; the repair runs only on the minute-0 run (once an hour).
export function isRequeueTime(now: Date): boolean {
  return now.getUTCMinutes() === 0;
}

const REQUEUE_MARKER = 'Re-queued once after MusicBrainz 503 (slice 11.7).';

// One-time repair: resolve_artists jobs that failed on a MusicBrainz 503 before
// the job could park are put back to waiting. A log line is the marker, so a job
// is never re-queued twice. Idempotent. Returns the ids re-queued.
export async function requeueFailedResolveArtists(deps: PipelineDeps, limit = 500): Promise<string[]> {
  const now = deps.now();
  const out: string[] = [];
  for (const job of await deps.store.listJobs(limit)) {
    if (job.kind !== 'resolve_artists' || job.status !== 'failed') continue;
    if (!/\b503\b/.test(job.lastError ?? '')) continue;
    if (job.log.some((e) => e.message === REQUEUE_MARKER)) continue;
    log(job, REQUEUE_MARKER, now);
    job.status = 'waiting_quota';
    job.stage = 'collect';
    job.attempts = 0;
    job.waitingReason = 'MusicBrainz was unavailable; trying again shortly.';
    job.nextAttemptAt = new Date(now.getTime() + MB_PARK_BASE_MS).toISOString();
    job.updatedAt = now.toISOString();
    await deps.store.updateJob(job);
    out.push(job.id);
  }
  return out;
}

// Runs stages until the job finishes or must wait. Never fabricates: a stage
// that cannot run leaves the job parked with a reason. force = a person
// pressed "retry now". oneStep runs a single stage (or one page of
// extraction) and leaves the job queued for the next call; the Worker uses it
// so no single invocation exceeds the subrequest limit.
export async function runJob(
  deps: PipelineDeps,
  jobId: string,
  opts: { force?: boolean; oneStep?: boolean } = {},
): Promise<LookupJob | null> {
  const force = Boolean(opts.force);
  const job = await deps.store.getJob(jobId);
  const now = deps.now();
  if (!job || !(['queued', 'waiting_quota'].includes(job.status) || isStaleRun(job, now))) return job;
  if (job.userId && deps.hasActiveUser && !(await deps.hasActiveUser(job.userId))) {
    job.status = 'waiting_quota';
    job.waitingReason = 'Paused: this member is blocked or removed. Nothing was sent to any source.';
    job.nextAttemptAt = undefined;
    job.updatedAt = now.toISOString();
    await deps.store.updateJob(job);
    return job;
  }
  job.status = 'running';
  job.waitingReason = undefined;
  job.nextAttemptAt = undefined;
  job.updatedAt = now.toISOString();
  await deps.store.updateJob(job);

  try {
    if (job.kind === 'resolve_artists') {
      await runResolveArtists(deps, job, now);
    } else {
      while (job.stage !== 'done') {
        if (job.stage === 'collect') await stageCollect(deps, job, now);
        else if (job.stage === 'extract') await stageExtract(deps, job, now, force);
        else if (job.stage === 'discover') await stageDiscover(deps, job, now, force);
        else if (job.stage === 'merge') await stageMerge(deps, job, now);
        if (opts.oneStep) break;
        job.updatedAt = deps.now().toISOString();
        await deps.store.updateJob(job);
      }
      if (job.stage !== 'done' && job.status === 'running') job.status = 'queued';
    }
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      if (err.scope === 'global') await deps.quota?.markExhausted(err.retryAt, now);
      job.status = 'waiting_quota';
      job.nextAttemptAt = err.retryAt.toISOString();
      job.waitingReason = err.reason;
      log(job, `Paused: ${err.reason}`, now);
    } else {
      job.attempts += 1;
      job.lastError = redactSecrets(err instanceof Error ? err.message : String(err));
      if (job.attempts < MAX_ATTEMPTS) {
        job.status = 'queued';
        job.nextAttemptAt = new Date(now.getTime() + 2 ** job.attempts * 60_000).toISOString();
        log(job, `Error, will retry: ${job.lastError}`, now);
      } else {
        job.status = 'failed';
        log(job, `Failed after ${job.attempts} attempts: ${job.lastError}`, now);
      }
    }
  }
  job.updatedAt = deps.now().toISOString();
  // The final save may use the budget's reserve, so a spent budget cannot lose the job's state.
  currentBudget()?.take(1, { reserved: true });
  await deps.store.updateJob(job);
  return job;
}

export async function enqueueArtistResolution(deps: PipelineDeps): Promise<void> {
  const now = deps.now().toISOString();
  await deps.store.createJob({
    id: randomUUID(),
    kind: 'resolve_artists',
    input: { eventName: 'artist resolution', year: new Date().getUTCFullYear() },
    editionKey: '*',
    status: 'queued',
    stage: 'collect',
    attempts: 0,
    pendingExtraction: [],
    discoveryDone: true,
    facts: {},
    log: [],
    createdAt: now,
    updatedAt: now,
  });
}
