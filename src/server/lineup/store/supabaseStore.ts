import { SupabaseClient } from '@supabase/supabase-js';
import type { AiCallRow, IngestTraceRow, MergeSummary } from './types';
import type { CanonicalVenue, EditionChange, EditionInference, InferenceStatus, InferenceVote, NewEditionInference, ReviewQueueItem, ReviewQueueKind } from '../types';
import { ArtistIdTakenError, assertNoPersonalFields, ExternalIdConflictError, venueIdFor } from './types';
import {
  ArtistIdentity,
  BlocklistEntry,
  Correction,
  Edition,
  EditionArtistRef,
  EditionHeader,
  EditionPerformance,
  ExtractionExample,
  LookupJob,
  PerformerClaim,
  QuotaUsage,
  SeriesKind,
  SeriesRecord,
  SeriesSummary,
  SourceDocument,
  SourceStat,
  SourceType,
} from '../types';
import { LoggedEvent } from '../../events/types';
import { diffEvent, type ActivityDraft, type ActivityEntry } from '../../events/activityLog';
import { isCiphertext } from '../../auth/vault';
import { splitEventCity } from '../../events/regions';
import { LineupFacts, lineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';
import type { ArtistGenres } from '../../events/genres';
import { brandKey } from '../../brands/plan';
import { findOrCreateBrandId } from '../../brands/store';
import {
  ArtistPerformanceRow,
  CanonicalApplyResult,
  CanonicalHistoryEntry,
  CanonicalHistoryPage,
  CanonicalHistoryPageOptions,
  CanonicalStoreError,
  CanonicalUndoResult,
  decodeCanonicalHistoryCursor,
  encodeCanonicalHistoryCursor,
  isCanonicalOperation,
  LineupStore,
  MAX_EXAMPLES_PER_DOMAIN,
  normalizeCanonicalHistoryLimit,
  roundRobin,
  STALE_RUN_MS,
  isEditionSuggestQuery,
  suggestEditionMatches,
  EditionOccurrenceConflictError,
  type EditionConflictInfo,
  type CanonicalEditionPageOptions,
  type CanonicalEditionStatusFilter,
  type SuggestEditionOptions,
  type UserScope,
} from './types';
import { normalizeName } from '../normalizeName';
import type { SqlCanonicalEntry } from '../../entities/canonicalManage';
import { ArtistEditionRow, CANONICAL_OPERATIONS, Entity, EntityAlias, EntityLink, HistoryEntry } from '../../entities/types';
import { checkLinks } from '../../entities/integrity';
import type { PreflightReply } from '../../reader/guard';
import { SHARE_EVENT_COLUMNS, type ShareLink } from '../../share/types';
import type { CachedResponse } from '../responseCache';

// Postgres-backed store. Tables are defined in
// supabase/migrations/0002_source_first_lineups.sql, 0003_event_log.sql and
// 0004_email_imports.sql (optional: only email import needs it).
export { EditionOccurrenceConflictError, type EditionConflictInfo };


function mapEditionInference(r: any): EditionInference {
  return {
    id: r.id, editionId: r.edition_id, field: r.field, ...(r.subject != null ? { subject: r.subject } : {}), value: r.value, reason: r.reason, rule: r.rule,
    inputs: r.inputs ?? [], parents: r.parents ?? [], status: r.status, actor: r.actor, createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? undefined, resolvedBy: r.resolved_by ?? undefined, resolvedReason: r.resolved_reason ?? undefined,
  };
}

function mapInferenceVote(r: any): InferenceVote {
  return { id: r.id, inferenceId: r.inference_id, memberId: r.member_id, createdAt: r.created_at };
}

export class SupabaseLineupStore implements LineupStore {
  readonly kind = 'supabase' as const;

  // Without a scope this is the single-owner store, or the system store the
  // queue, cron and share page use (service key). With one, every read of a
  // personal table (lookup_jobs, logged_events, email_imports, share_links,
  // user_settings) is filtered to scope.userId and every write carries it.
  // scope.db, when set, is a client holding the member's 60-second token, so
  // row level security is a second lock on those tables; shared tables still
  // go through the service client.
  constructor(
    private readonly db: SupabaseClient,
    private readonly scope?: UserScope,
  ) {}

  private ownerId: { value: string | null } | null = null;

  // The owner's user id from the members table (0017), read once. Only the
  // finished value is kept: a promise shared with a later request can never
  // settle once the request that made it has ended.
  async ownerUserId(): Promise<string | null> {
    if (this.ownerId) return this.ownerId.value;
    const { data, error } = await this.db.from('members').select('user_id').eq('role', 'owner').maybeSingle();
    const value: string | null = error ? null : ((data as any)?.user_id ?? null);
    this.ownerId = { value };
    return value;
  }

  forUser(scope: UserScope): LineupStore {
    return new SupabaseLineupStore(this.db, scope);
  }

  private own(table: string) {
    return (this.scope?.db ?? this.db).from(table);
  }

  // Supabase's query builder types are too deep to constrain here.
  private mine<Q>(q: Q): Q {
    return this.scope ? (q as any).eq('user_id', this.scope.userId) : q;
  }

  private stamp<R extends object>(row: R): R {
    return this.scope ? { ...row, user_id: this.scope.userId } : row;
  }

  private check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
    if (result.error) throw new Error(`Supabase ${what} failed: ${result.error.message}`);
    return result.data;
  }

  // Jobs ------------------------------------------------------------------

  private jobToRow(job: LookupJob) {
    return {
      id: job.id,
      kind: job.kind,
      edition_key: job.editionKey,
      status: job.status,
      stage: job.stage,
      input: job.input,
      attempts: job.attempts,
      next_attempt_at: job.nextAttemptAt ?? null,
      waiting_reason: job.waitingReason ?? null,
      last_error: job.lastError ?? null,
      pending_extraction: job.pendingExtraction,
      discovery_done: job.discoveryDone,
      facts: job.facts,
      candidate: job.candidate ?? null,
      edition_id: job.editionId ?? null,
      event_id: job.eventId ?? null,
      log: job.log,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      // Left out when unknown, so an update never clears the owner of a row.
      ...(job.userId ? { user_id: job.userId } : {}),
    };
  }

  private rowToJob(row: any): LookupJob {
    return {
      id: row.id,
      kind: row.kind,
      editionKey: row.edition_key,
      status: row.status,
      stage: row.stage,
      input: row.input,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at ?? undefined,
      waitingReason: row.waiting_reason ?? undefined,
      lastError: row.last_error ?? undefined,
      pendingExtraction: row.pending_extraction ?? [],
      discoveryDone: row.discovery_done,
      facts: row.facts ?? {},
      candidate: row.candidate ?? undefined,
      editionId: row.edition_id ?? undefined,
      eventId: row.event_id ?? undefined,
      log: row.log ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userId: row.user_id ?? undefined,
    };
  }

  async createJob(job: LookupJob) {
    this.check(await this.own('lookup_jobs').insert(this.stamp(this.jobToRow(job))), 'createJob');
  }

  async getJob(id: string) {
    const data = this.check(await this.mine(this.own('lookup_jobs').select('*').eq('id', id)).maybeSingle(), 'getJob');
    return data ? this.rowToJob(data) : null;
  }

  async updateJob(job: LookupJob) {
    this.check(await this.own('lookup_jobs').upsert(this.stamp(this.jobToRow(job))), 'updateJob');
  }

  async listJobs(limit: number) {
    const data = this.check(
      await this.mine(this.own('lookup_jobs').select('*')).order('created_at', { ascending: false }).limit(limit),
      'listJobs',
    );
    return (data ?? []).map((r) => this.rowToJob(r));
  }

  async listCanonicalJobs(limit: number) {
    const data = this.check(
      await this.mine(this.own('lookup_jobs').select('*').is('event_id', null)).order('created_at', { ascending: false }).limit(limit),
      'listCanonicalJobs',
    );
    return (data ?? []).map((r) => this.rowToJob(r));
  }

  async getJobs(ids: string[]) {
    if (!ids.length) return [];
    const data = this.check(await this.mine(this.own('lookup_jobs').select('*').in('id', ids)), 'getJobs');
    return (data ?? []).map((r) => this.rowToJob(r));
  }

  async dueJobs(now: Date, limit: number) {
    const iso = now.toISOString();
    const staleIso = new Date(now.getTime() - STALE_RUN_MS).toISOString();
    const data = this.check(
      await this.db
        .from('lookup_jobs')
        .select('*')
        // Due queued or paused jobs, and runs that were cut off (isStaleRun).
        .or(
          `and(status.in.(queued,waiting_quota),or(next_attempt_at.is.null,next_attempt_at.lte.${iso})),` +
            `and(status.eq.running,updated_at.lte.${staleIso})`,
        )
        .order('created_at', { ascending: true })
        // More than asked for, so the turn-taking below has every member's oldest.
        .limit(limit * 20),
      'dueJobs',
    );
    return roundRobin((data ?? []).map((r) => this.rowToJob(r)), limit);
  }

  // Evidence --------------------------------------------------------------

  async putDocument(doc: SourceDocument) {
    const existing = this.check(
      await this.db
        .from('source_documents')
        .select('id, url, source_type, fetched_at, content_hash, content_type')
        .eq('url', doc.url)
        .eq('content_hash', doc.contentHash)
        .maybeSingle(),
      'putDocument lookup',
    );
    if (existing) {
      return {
        id: existing.id,
        url: existing.url,
        sourceType: existing.source_type,
        fetchedAt: existing.fetched_at,
        contentHash: existing.content_hash,
        contentType: existing.content_type,
        body: doc.body,
      };
    }
    this.check(
      await this.db.from('source_documents').insert({
        id: doc.id,
        url: doc.url,
        source_type: doc.sourceType,
        fetched_at: doc.fetchedAt,
        content_hash: doc.contentHash,
        content_type: doc.contentType,
        body: doc.body,
      }),
      'putDocument',
    );
    return doc;
  }

  async getDocument(id: string) {
    const row = this.check(await this.db.from('source_documents').select('*').eq('id', id).maybeSingle(), 'getDocument');
    if (!row) return null;
    return {
      id: row.id,
      url: row.url,
      sourceType: row.source_type,
      fetchedAt: row.fetched_at,
      contentHash: row.content_hash,
      contentType: row.content_type,
      body: row.body,
    };
  }

  async addPerformerClaims(claims: PerformerClaim[]) {
    if (claims.length === 0) return;
    this.check(
      await this.db.from('performer_claims').insert(
        claims.map((c) => ({
          id: c.id,
          job_id: c.jobId,
          document_id: c.documentId,
          source_type: c.sourceType,
          source_url: c.sourceUrl,
          name: c.name,
          quoted_span: c.quotedSpan,
          evidence: c.evidence,
          day: c.day ?? null,
          stage: c.stage ?? null,
          start_time: c.startTime ?? null,
          end_time: c.endTime ?? null,
          mbid: c.mbid ?? null,
          billing: c.billing ?? null,
          extractor: c.extractor,
          extractor_version: c.extractorVersion,
          created_at: c.createdAt,
        })),
      ),
      'addPerformerClaims',
    );
  }

  async listPerformerClaims(jobId: string) {
    const data = this.check(await this.db.from('performer_claims').select('*').eq('job_id', jobId), 'listPerformerClaims');
    return (data ?? []).map(rowToClaim);
  }

  async findExtractedClaims(q: { editionKey: string; documentId: string; extractor: string; extractorVersion: string; excludeJobId: string }) {
    const jobs = this.check(
      await this.db
        .from('lookup_jobs')
        .select('id')
        .eq('edition_key', q.editionKey)
        .neq('id', q.excludeJobId)
        .order('created_at', { ascending: false })
        .limit(20),
      'findExtractedClaims jobs',
    );
    const jobIds = (jobs ?? []).map((j: { id: string }) => j.id);
    if (!jobIds.length) return [];
    const data = this.check(
      await this.db
        .from('performer_claims')
        .select('*')
        .in('job_id', jobIds)
        .eq('document_id', q.documentId)
        .eq('extractor', q.extractor)
        .eq('extractor_version', q.extractorVersion),
      'findExtractedClaims',
    );
    const claims = (data ?? []).map(rowToClaim);
    // One earlier job's claims, so two cached runs are not added together.
    const first = claims[0]?.jobId;
    return claims.filter((c) => c.jobId === first);
  }

  // Canonical -------------------------------------------------------------

  private static readonly EDITION_HEADER_COLUMNS =
    'id, key, series_slug, year, name, start_date, end_date, venue, city, region, country, weekends, status, venue_id, subject_key, has_lineup, confirmed_at, updated_at, fact_source_note, event_series(name, brand, aliases, kind, city, region, country)';

  private static readonly EDITION_SELECT_WITH_SERIES = '*, event_series(name, brand, aliases, kind, city, region, country)';

  private rowToSeries(r: any): SeriesRecord {
    const kind: SeriesKind | undefined = r.kind === 'tour' || r.kind === 'festival' ? r.kind : undefined;
    return {
      slug: r.slug,
      name: r.name,
      ...(kind ? { kind } : {}),
      ...(r.brand != null ? { brand: r.brand } : {}),
      ...(kind !== 'tour' && r.city != null ? { city: r.city } : {}),
      ...(kind !== 'tour' && r.region != null ? { region: r.region } : {}),
      ...(kind !== 'tour' && r.country != null ? { country: r.country } : {}),
      ...(Array.isArray(r.aliases) && r.aliases.length ? { aliases: r.aliases } : {}),
      lineupUrl: r.lineup_url ?? undefined,
      clashfinderSlugs: r.clashfinder_slugs ?? {},
      sourcePriority: r.source_priority ?? undefined,
    };
  }

  async getSeries(slug: string) {
    const r = this.check(await this.db.from('event_series').select('*').eq('slug', slug).maybeSingle(), 'getSeries');
    return r ? this.rowToSeries(r) : null;
  }

  // brand_id follows the brand text only when the text changes, so a brand moved in the Brands tab
  // is not undone by an unrelated series edit. A series with no brand text loses its brand link.
  private async brandIdPatch(s: SeriesRecord): Promise<{ brand_id?: string | null }> {
    const before = this.check(
      await this.db.from('event_series').select('brand').eq('slug', s.slug).maybeSingle(),
      'upsertSeries.brand',
    );
    const oldKey = before?.brand?.trim() ? brandKey(before.brand) : null;
    const newText = s.brand?.trim() ? s.brand : null;
    const newKey = newText ? brandKey(newText) : null;
    if (oldKey === newKey) return {};
    if (!newText) return { brand_id: null };
    return { brand_id: await findOrCreateBrandId(this.db, newText) };
  }

  async upsertSeries(s: SeriesRecord) {
    // No type stays empty (NULL, "Not set"): a series is never typed festival by default (series type fix).
    const kind: SeriesKind | null = s.kind === 'tour' || s.kind === 'festival' ? s.kind : null;
    const isTour = kind === 'tour';
    const brandPatch = await this.brandIdPatch(s);
    this.check(
      await this.db.from('event_series').upsert({
        slug: s.slug,
        name: s.name,
        kind,
        brand: s.brand ?? null,
        ...brandPatch,
        city: isTour ? null : (s.city ?? null),
        region: isTour ? null : (s.region ?? null),
        country: isTour ? null : (s.country ?? null),
        aliases: s.aliases ?? [],
        lineup_url: s.lineupUrl ?? null,
        clashfinder_slugs: s.clashfinderSlugs ?? {},
        source_priority: s.sourcePriority ?? null,
      }),
      'upsertSeries',
    );
  }

  async listSeries(opts: { query?: string; brand?: string; limit?: number } = {}): Promise<SeriesSummary[]> {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const { data, error } = await this.db.rpc('list_canonical_series_summary', {
      p_query: opts.query?.trim() || null,
      p_brand: opts.brand?.trim() || null,
      p_limit: limit,
    });
    if (error) throw new Error(`listSeries (apply 0046_series_kind_and_place.sql): ${error.message}`);
    return ((data ?? []) as any[]).map((r) => ({
      ...this.rowToSeries(r),
      editionCount: Number(r.edition_count ?? 0),
    }));
  }

  async mergeSeries(keepSlug: string, dropSlug: string): Promise<MergeSummary> {
    const { data, error } = await this.db.rpc('merge_canonical_series', {
      p_keep_slug: keepSlug,
      p_drop_slug: dropSlug,
    });
    if (error) throw new Error(`mergeSeries (apply 0046_series_kind_and_place.sql): ${error.message}`);
    return (data ?? {}) as MergeSummary;
  }

  private async loadEdition(row: any): Promise<Edition> {
    const perfs = this.check(
      await this.db.from('performances').select('*').eq('edition_id', row.id),
      'loadEdition performances',
    );
    return this.toEdition(row, perfs ?? []);
  }

  // One performances row as an edition performance (the row carries no edition ID).
  private toPerformance(p: any): EditionPerformance {
    return {
      artistKey: p.artist_key,
      slotId: p.slot_id ?? undefined,
      alias: p.alias ?? undefined,
      set: p.set ?? undefined,
      // Keep the stored value as it is: '{}' (empty) and NULL are different rows to the canonical apply's
      // fingerprint check (canonical_artist_state compares them as jsonb). Collapsing '{}' to undefined made
      // every preview of an artist with such a row fail as "out of date".
      b2b: p.b2b ?? undefined,
      name: p.name,
      days: p.days ?? [],
      stages: p.stages ?? [],
      status: p.status,
      billing: p.billing ?? undefined,
      verification: (p.verification as EditionPerformance['verification']) ?? 'verified',
      confidence: Number(p.confidence),
      sources: p.sources ?? [],
    };
  }

  private performanceRow(editionId: string, p: EditionPerformance) {
    const row: Record<string, any> = {
      edition_id: editionId,
      artist_key: p.artistKey,
      name: p.name,
      days: p.days,
      stages: p.stages,
      status: p.status,
      billing: p.billing ?? null,
      verification: p.verification ?? 'verified',
      confidence: p.confidence,
      sources: p.sources,
    };
    if (p.slotId) row.slot_id = p.slotId;
    if (p.alias) row.alias = p.alias;
    if (p.set) row.set = p.set;
    if (p.b2b?.length) row.b2b = p.b2b;
    return row;
  }

  private toEditionHeader(row: any): EditionHeader {
    const series = Array.isArray(row.event_series) ? row.event_series[0] : row.event_series;
    const seriesKind: SeriesKind | undefined = series?.kind === 'tour' || series?.kind === 'festival' ? series.kind : undefined;
    return {
      id: row.id,
      key: row.key,
      ...(row.series_slug != null ? { seriesSlug: row.series_slug } : {}),
      ...(series?.name != null ? { seriesName: series.name } : {}),
      ...(series?.brand != null ? { seriesBrand: series.brand } : {}),
      ...(Array.isArray(series?.aliases) && series.aliases.length ? { seriesAliases: series.aliases } : {}),
      ...(seriesKind ? { seriesKind } : {}),
      ...(seriesKind !== 'tour' && series?.city != null ? { seriesCity: series.city } : {}),
      ...(seriesKind !== 'tour' && series?.region != null ? { seriesRegion: series.region } : {}),
      ...(seriesKind !== 'tour' && series?.country != null ? { seriesCountry: series.country } : {}),
      year: row.year,
      name: row.name,
      startDate: row.start_date ?? undefined,
      endDate: row.end_date ?? undefined,
      venue: row.venue ?? undefined,
      city: row.city ?? undefined,
      region: row.region ?? undefined,
      country: row.country ?? undefined,
      ...(Array.isArray(row.weekends) && row.weekends.length ? { weekends: row.weekends } : {}),
      ...(row.venue_id != null ? { venueId: row.venue_id } : {}),
      ...(row.subject_key != null ? { subjectKey: row.subject_key } : {}),
      ...(row.has_lineup != null ? { hasLineup: row.has_lineup } : {}),
      status: row.status,
      confirmedAt: row.confirmed_at ?? undefined,
      updatedAt: row.updated_at,
      factSourceNote: row.fact_source_note ?? undefined,
      ...(row.weather != null ? { weather: row.weather } : {}),
    };
  }

  private toEdition(row: any, perfs: any[]): Edition {
    return {
      ...this.toEditionHeader(row),
      performances: perfs.map((p: any) => this.toPerformance(p)),
    };
  }

  // A few requests for many editions: ids go in the URL 100 at a time, and
  // performances come in pages of 1000 (Supabase's row cap per select).
  async getEditions(ids: string[]) {
    const out: Edition[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = this.check(
        await this.db.from('event_editions').select(SupabaseLineupStore.EDITION_SELECT_WITH_SERIES).in('id', chunk),
        'getEditions',
      );
      const perfs: any[] = [];
      for (let from = 0; ; from += 1000) {
        const page = this.check(
          await this.db.from('performances').select('*').in('edition_id', chunk).order('edition_id').order('artist_key').range(from, from + 999),
          'getEditions performances',
        );
        perfs.push(...(page ?? []));
        if ((page ?? []).length < 1000) break;
      }
      for (const r of rows ?? []) out.push(this.toEdition(r, perfs.filter((p: any) => p.edition_id === r.id)));
    }
    return out;
  }

  async getEditionHeaders(ids: string[]): Promise<EditionHeader[]> {
    const out: EditionHeader[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = this.check(
        await this.db.from('event_editions').select(SupabaseLineupStore.EDITION_HEADER_COLUMNS).in('id', chunk),
        'getEditionHeaders',
      );
      for (const r of rows ?? []) out.push(this.toEditionHeader(r));
    }
    return out;
  }

  async getEditionByKey(key: string) {
    const row = this.check(
      await this.db.from('event_editions').select(SupabaseLineupStore.EDITION_SELECT_WITH_SERIES).eq('key', key).maybeSingle(),
      'getEditionByKey',
    );
    return row ? this.loadEdition(row) : null;
  }

  async getEdition(id: string) {
    const row = this.check(
      await this.db.from('event_editions').select(SupabaseLineupStore.EDITION_SELECT_WITH_SERIES).eq('id', id).maybeSingle(),
      'getEdition',
    );
    return row ? this.loadEdition(row) : null;
  }

  async findEditionByOccurrence(startDate: string, venueId: string, subjectKey: string): Promise<Edition | null> {
    const row = this.check(
      await this.db
        .from('event_editions')
        .select(SupabaseLineupStore.EDITION_SELECT_WITH_SERIES)
        .eq('start_date', startDate)
        .eq('venue_id', venueId)
        .eq('subject_key', subjectKey)
        .maybeSingle(),
      'findEditionByOccurrence',
    );
    return row ? this.loadEdition(row) : null;
  }

  async upsertEdition(e: Edition) {
    const seriesSlug = e.seriesSlug?.trim() || null;
    if (seriesSlug) {
      const series = await this.getSeries(seriesSlug);
      if (!series) await this.upsertSeries({ slug: seriesSlug, name: e.seriesName ?? e.name });
    }
    const written = await this.db.from('event_editions').upsert({
      id: e.id,
      key: e.key,
      series_slug: seriesSlug,
      year: e.year,
      name: e.name,
      start_date: e.startDate ?? null,
      end_date: e.endDate ?? null,
      venue: e.venue ?? null,
      city: e.city ?? null,
      region: e.region ?? null,
      country: e.country ?? null,
      weekends: e.weekends ?? [],
      venue_id: e.venueId ?? null,
      subject_key: e.subjectKey ?? null,
      has_lineup: e.performances.length > 0 ? true : (e.hasLineup ?? null),
      status: e.status,
      confirmed_at: e.confirmedAt ?? null,
      fact_source_note: e.factSourceNote ?? null,
      // Left out when unset, so an edition save that does not carry weather keeps the stored record.
      ...(e.weather !== undefined ? { weather: e.weather } : {}),
      updated_at: e.updatedAt,
    });
    // event_editions_occurrence_uidx: another edition already holds this date, venue and subject.
    const err = written.error as { code?: string; message: string } | null;
    if (err && (err.code === '23505' || /event_editions_occurrence_uidx/.test(err.message))) {
      let conflictingEdition: EditionConflictInfo | undefined;
      if (e.startDate && e.venueId && e.subjectKey) {
        try {
          const clash = await this.findEditionByOccurrence(e.startDate, e.venueId, e.subjectKey);
          if (clash && clash.id !== e.id) {
            conflictingEdition = { id: clash.id, key: clash.key, name: clash.name };
          }
        } catch {
          // ignore lookup errors
        }
      }
      throw new EditionOccurrenceConflictError(e.id, e.startDate, e.venueId, e.subjectKey, conflictingEdition);
    }
    this.check(written, 'upsertEdition');
    await this.ensureArtists(e.performances.map((p) => ({ key: p.artistKey, name: p.name })));
    this.check(await this.db.from('performances').delete().eq('edition_id', e.id), 'upsertEdition clear');
    if (e.performances.length > 0) {
      this.check(
        await this.db.from('performances').insert(
          e.performances.map((p) => this.performanceRow(e.id, p)),
        ),
        'upsertEdition performances',
      );
    }
  }

  async editionLineupFacts(ids: string[]) {
    const out: Record<string, LineupFacts> = {};
    if (!ids.length) return out;
    if (typeof (this.db as any).rpc === 'function') {
      const res = await this.db.rpc('edition_lineup_facts', { p_ids: ids });
      if (res.error) throw new Error(`editionLineupFacts (apply 0045_canonical_series_brand_weekends.sql): ${res.error.message}`);
      if (Array.isArray(res.data)) {
        for (const id of ids) out[id] = { acts: 0, clashfinder: false };
        for (const r of res.data as Array<{ edition_id: string; act_count: number | string; has_clashfinder: boolean }>) {
          out[r.edition_id] = { acts: Number(r.act_count ?? 0), clashfinder: Boolean(r.has_clashfinder) };
        }
        return out;
      }
    }
    const rows = this.check(
      await this.db.from('performances').select('edition_id, status, sources').in('edition_id', ids),
      'editionLineupFacts',
    );
    const byEdition = new Map<string, any[]>();
    for (const r of rows ?? []) byEdition.set(r.edition_id, [...(byEdition.get(r.edition_id) ?? []), r]);
    for (const id of ids) out[id] = lineupFacts({ performances: byEdition.get(id) ?? [] });
    return out;
  }

  // One query for the edition rows, then the batched loader (getEditions):
  // loading each edition on its own cost one Worker subrequest per row, which
  // hit Workers' 50-subrequest limit on a long list.
  async listEditions(limit: number) {
    const rows = this.check(
      await this.db.from('event_editions').select('id').order('updated_at', { ascending: false }).limit(limit),
      'listEditions',
    );
    const ids = (rows ?? []).map((r: any) => r.id as string);
    const loaded = new Map((await this.getEditions(ids)).map((e) => [e.id, e]));
    return ids.map((id) => loaded.get(id)).filter((e): e is Edition => Boolean(e));
  }

  async listEditionHeaders(
    opts?: number | { limit?: number; startDate?: string; seriesSlug?: string; year?: number; status?: CanonicalEditionStatusFilter },
  ): Promise<EditionHeader[]> {
    const normalized = typeof opts === 'number' ? { limit: opts } : (opts ?? {});
    const limit = Math.max(0, Math.floor(normalized.limit ?? 500));
    let query: any = this.db.from('event_editions').select(SupabaseLineupStore.EDITION_HEADER_COLUMNS);
    if (normalized.startDate) query = query.eq('start_date', normalized.startDate);
    if (normalized.seriesSlug) query = query.eq('series_slug', normalized.seriesSlug);
    if (normalized.year !== undefined) query = query.eq('year', normalized.year);
    if (normalized.status === 'verified' || normalized.status === 'confirmed') query = query.in('status', ['verified', 'confirmed']);
    else if (normalized.status && normalized.status !== 'all') query = query.eq('status', normalized.status);
    const rows = this.check(
      await query.order('updated_at', { ascending: false }).limit(limit),
      'listEditionHeaders',
    ) as any[] | null;
    return (rows ?? []).map((r: any) => this.toEditionHeader(r));
  }

  async listEditionArtistRefs(opts: { editionIds?: string[]; verifiedOnly?: boolean } = {}): Promise<EditionArtistRef[]> {
    const out: EditionArtistRef[] = [];
    const mapRow = (r: any): EditionArtistRef => ({
      editionId: r.edition_id,
      artistKey: r.artist_key,
      name: r.name,
      status: r.status,
    });
    if (opts.editionIds) {
      if (!opts.editionIds.length) return out;
      for (let i = 0; i < opts.editionIds.length; i += 100) {
        const chunk = opts.editionIds.slice(i, i + 100);
        for (let from = 0; ; from += 1000) {
          let q: any = this.db
            .from('performances')
            .select(opts.verifiedOnly ? 'edition_id, artist_key, name, status, event_editions!inner(status)' : 'edition_id, artist_key, name, status')
            .in('edition_id', chunk);
          if (opts.verifiedOnly) q = q.in('event_editions.status', ['verified', 'confirmed']);
          const page = (this.check(await q.order('edition_id').order('artist_key').range(from, from + 999), 'listEditionArtistRefs') ?? []) as any[];
          for (const r of page) out.push(mapRow(r));
          if (page.length < 1000) break;
        }
      }
      return out;
    }
    for (let from = 0; ; from += 1000) {
      let q: any = this.db
        .from('performances')
        .select(opts.verifiedOnly ? 'edition_id, artist_key, name, status, event_editions!inner(status)' : 'edition_id, artist_key, name, status');
      if (opts.verifiedOnly) q = q.in('event_editions.status', ['verified', 'confirmed']);
      const page = (this.check(await q.order('edition_id').order('artist_key').range(from, from + 999), 'listEditionArtistRefs') ?? []) as any[];
      for (const r of page) out.push(mapRow(r));
      if (page.length < 1000) break;
    }
    return out;
  }

  // Narrows in the database with ilike on the longest typed word (including series name, brand, aliases),
  // then applies suggestEditionMatches in code so both stores return the same editions.
  async suggestEditions(query: string, opts: SuggestEditionOptions) {
    if (!isEditionSuggestQuery(query)) return [];
    const words = normalizeName(query).split(' ').filter((t) => t && !/^\d{4}$/.test(t));
    if (words.length === 0) return [];
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    const escaped = longest.replace(/[\\%_*]/g, '\\$&').replace(/"/g, '\\"');
    const pattern = `"%${escaped}%"`;

    let matchingSlugs: string[] = [];
    if (typeof (this.db as any).rpc === 'function') {
      const series = await this.listSeries({ query: longest, limit: 60 });
      matchingSlugs = series.map((s) => s.slug);
    } else {
      const sRows = this.check(
        await this.db.from('event_series').select('slug').or(`name.ilike.${pattern},brand.ilike.${pattern}`).limit(60),
        'suggestEditions series',
      );
      matchingSlugs = (sRows ?? []).map((r: any) => r.slug as string);
    }

    const orParts = [`name.ilike.${pattern}`, `series_slug.ilike.${pattern}`];
    if (matchingSlugs.length > 0) {
      const quoted = matchingSlugs.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(',');
      orParts.push(`series_slug.in.(${quoted})`);
    }

    const rows = this.check(
      await this.db
        .from('event_editions')
        .select(SupabaseLineupStore.EDITION_HEADER_COLUMNS)
        .in('status', ['confirmed', 'verified'])
        .or(orParts.join(','))
        // Bound the editions loaded per keystroke; newest first so recent editions are kept.
        .order('start_date', { ascending: false, nullsFirst: false })
        .limit(60),
      'suggestEditions',
    );
    const candidates = (rows ?? []).map((r: any) => this.toEditionHeader(r));
    const suggestions = suggestEditionMatches(candidates, query, opts);
    if (!suggestions.length) return [];
    const matchedIds = suggestions.map((s) => s.id);
    const facts = await this.editionLineupFacts(matchedIds);
    for (const s of suggestions) s.actCount = facts[s.id]?.acts ?? 0;
    return suggestions;
  }

  async listCanonicalEditionsPage(options: CanonicalEditionPageOptions) {
    const queryText = (options.query ?? '').trim();
    const limit = Math.max(0, Math.min(200, Math.floor(options.limit)));
    let query = this.db
      .from('event_editions')
      .select(SupabaseLineupStore.EDITION_HEADER_COLUMNS, { count: 'exact' });
    if (options.status === 'verified' || options.status === 'confirmed') query = query.in('status', ['verified', 'confirmed']);
    else if (options.status && options.status !== 'all') query = query.eq('status', options.status);
    if (queryText) {
      const escaped = queryText.replace(/[\\%_*]/g, '\\$&').replace(/"/g, '\\"');
      const pattern = `"%${escaped}%"`;
      query = query.or(`name.ilike.${pattern},series_slug.ilike.${pattern},venue.ilike.${pattern}`);
    }
    const result = await query
      .order('year', { ascending: false })
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);
    const rows = this.check(result, 'listCanonicalEditionsPage') ?? [];
    if (result.count === null) throw new Error('Supabase listCanonicalEditionsPage did not return an exact count.');
    if (!rows.length) {
      return { editions: [], total: result.count, hasMore: false };
    }
    const ids = rows.map((row: any) => row.id as string);
    const perfsByEdition = new Map<string, any[]>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      for (let from = 0; ; from += 1000) {
        const page = this.check(
          await this.db
            .from('performances')
            .select('edition_id, artist_key, name, days, stages, status, billing, confidence')
            .in('edition_id', chunk)
            .order('edition_id')
            .order('artist_key')
            .range(from, from + 999),
          'listCanonicalEditionsPage performances',
        );
        for (const p of page ?? []) {
          const list = perfsByEdition.get(p.edition_id);
          if (list) list.push(p);
          else perfsByEdition.set(p.edition_id, [p]);
        }
        if ((page ?? []).length < 1000) break;
      }
    }
    return {
      editions: rows.map((r: any) => this.toEdition(r, perfsByEdition.get(r.id) ?? [])),
      total: result.count,
      hasMore: result.count > rows.length,
    };
  }

  async stampUnsetWeekend(editionId: string, weekend: number): Promise<number> {
    const { data, error } = await this.db.rpc('stamp_unset_event_weekend', {
      p_edition_id: editionId,
      p_weekend: weekend,
    });
    if (error) throw new Error(`stampUnsetWeekend (apply 0045_canonical_series_brand_weekends.sql): ${error.message}`);
    return Number(data ?? 0);
  }

  // Quota -----------------------------------------------------------------

  async getQuota(key: string) {
    const r = this.check(await this.db.from('quota_ledger').select('*').eq('key', key).maybeSingle(), 'getQuota');
    return r ? { key: r.key, used: r.used, exhaustedUntil: r.exhausted_until ?? undefined } : null;
  }

  async setQuota(u: QuotaUsage) {
    this.check(
      await this.db.from('quota_ledger').upsert({ key: u.key, used: u.used, exhausted_until: u.exhaustedUntil ?? null }),
      'setQuota',
    );
  }

  // Learning --------------------------------------------------------------

  async getAliases() {
    const rows = this.check(await this.db.from('artist_aliases').select('*'), 'getAliases');
    const out: Record<string, string> = {};
    for (const r of rows ?? []) out[r.alias_normalized] = r.canonical_name;
    return out;
  }

  async putAliases(aliases: Record<string, string>) {
    const rows = Object.entries(aliases).map(([alias, name]) => ({ alias_normalized: alias, canonical_name: name }));
    if (rows.length) this.check(await this.db.from('artist_aliases').upsert(rows), 'putAliases');
  }

  async deleteAlias(alias: string) {
    this.check(await this.db.from('artist_aliases').delete().eq('alias_normalized', alias), 'deleteAlias');
  }

  async getBlocklist(domains: string[]) {
    const rows = this.check(await this.db.from('extraction_blocklist').select('*').in('domain', domains), 'getBlocklist');
    return (rows ?? []).map((r: any): BlocklistEntry => ({ domain: r.domain, normalized: r.normalized, rejections: r.rejections }));
  }

  // One read and one write for the whole list.
  async bumpBlocklist(entries: Array<{ domain: string; normalized: string }>) {
    if (!entries.length) return;
    const counts = new Map<string, { domain: string; normalized: string; rejections: number }>();
    for (const { domain, normalized } of entries) {
      const k = `${domain}\u0000${normalized}`;
      const c = counts.get(k) ?? { domain, normalized, rejections: 0 };
      c.rejections += 1;
      counts.set(k, c);
    }
    const rows = this.check(
      await this.db
        .from('extraction_blocklist')
        .select('*')
        .in('domain', [...new Set(entries.map((e) => e.domain))])
        .in('normalized', [...new Set(entries.map((e) => e.normalized))]),
      'bumpBlocklist lookup',
    );
    for (const r of rows ?? []) {
      const c = counts.get(`${r.domain}\u0000${r.normalized}`);
      if (c) c.rejections += r.rejections;
    }
    this.check(await this.db.from('extraction_blocklist').upsert([...counts.values()]), 'bumpBlocklist');
  }

  async getSourceStats() {
    const rows = this.check(await this.db.from('source_stats').select('*'), 'getSourceStats');
    return (rows ?? []).map(
      (r: any): SourceStat => ({ sourceType: r.source_type, scope: r.scope, accepted: r.accepted, rejected: r.rejected }),
    );
  }

  // One read and one write for the whole list.
  async bumpSourceStats(deltas: SourceStat[]) {
    if (!deltas.length) return;
    const sums = new Map<string, { source_type: SourceType; scope: string; accepted: number; rejected: number }>();
    for (const d of deltas) {
      const k = `${d.sourceType}\u0000${d.scope}`;
      const s = sums.get(k) ?? { source_type: d.sourceType, scope: d.scope, accepted: 0, rejected: 0 };
      s.accepted += d.accepted;
      s.rejected += d.rejected;
      sums.set(k, s);
    }
    const rows = this.check(
      await this.db
        .from('source_stats')
        .select('*')
        .in('source_type', [...new Set(deltas.map((d) => d.sourceType))])
        .in('scope', [...new Set(deltas.map((d) => d.scope))]),
      'bumpSourceStats lookup',
    );
    for (const r of rows ?? []) {
      const s = sums.get(`${r.source_type}\u0000${r.scope}`);
      if (s) {
        s.accepted += r.accepted;
        s.rejected += r.rejected;
      }
    }
    this.check(await this.db.from('source_stats').upsert([...sums.values()]), 'bumpSourceStats');
  }

  async addCorrections(list: Correction[]) {
    if (!list.length) return;
    this.check(
      await this.db.from('corrections').insert(
        list.map((c) => ({
          id: c.id,
          edition_key: c.editionKey,
          kind: c.kind,
          original: c.original ?? null,
          corrected: c.corrected ?? null,
          source_types: c.sourceTypes,
          source_urls: c.sourceUrls,
          created_at: c.createdAt,
        })),
      ),
      'addCorrections',
    );
  }

  async getExamples(domain: string) {
    const rows = this.check(
      await this.db
        .from('extraction_examples')
        .select('*')
        .eq('domain', domain)
        .order('created_at', { ascending: false })
        .limit(MAX_EXAMPLES_PER_DOMAIN),
      'getExamples',
    );
    return (rows ?? []).map(
      (r: any): ExtractionExample => ({ domain: r.domain, excerpt: r.excerpt, names: r.names, createdAt: r.created_at }),
    );
  }

  async addExample(e: ExtractionExample) {
    this.check(
      await this.db
        .from('extraction_examples')
        .insert({ domain: e.domain, excerpt: e.excerpt, names: e.names, created_at: e.createdAt }),
      'addExample',
    );
  }

  // Personal --------------------------------------------------------------

  private eventToRow(event: LoggedEvent) {
    const e = splitEventCity(event);
    return {
      id: e.id,
      input: e.input,
      name: e.name,
      year: e.year ?? null,
      month: e.month ?? null,
      start_date: e.startDate ?? null,
      end_date: e.endDate ?? null,
      venue: e.venue ?? null,
      city: e.city ?? null,
      region: e.region ?? null,
      country: e.country ?? null,
      sources: e.sources,
      details: e.details,
      lineup_job_id: e.lineupJobId ?? null,
      edition_id: e.editionId ?? null,
      seen: e.seen,
      kind: e.kind ?? null,
      format: e.format ?? null,
      series: e.series ?? null,
      weekend: e.weekend ?? null,
      attendance: e.attendance ?? null,
      weather: e.weather ?? null,
      days_attended: e.daysAttended,
      companions: e.companions,
      rating: e.rating ?? null,
      ticket_price: e.ticketPrice ?? null,
      notes: e.notes ?? null,
      // Only once linked (0014): an event saved without the entity tables
      // leaves these columns out, so it saves before the migration too.
      ...(e.personIds ? { person_ids: e.personIds } : {}),
      // 0041: written only when set, so a save works before the migration. The database keeps captured once set.
      ...(e.captured ? { captured: e.captured } : {}),
      ...(e.overrides ? { overrides: e.overrides } : {}),
      ...(e.refs
        ? {
            venue_id: e.refs.venueId,
            place_id: e.refs.placeId,
            series_id: e.refs.seriesId,
            companion_ids: e.refs.companionIds,
          }
        : {}),
      created_at: e.createdAt,
      updated_at: e.updatedAt,
    };
  }

  // Rows saved before the state had its own column still read "City, ST".
  private rowToEvent(r: any): LoggedEvent {
    return splitEventCity({
      id: r.id,
      input: r.input ?? '',
      name: r.name,
      year: r.year ?? undefined,
      month: r.month ?? undefined,
      startDate: r.start_date ?? undefined,
      endDate: r.end_date ?? undefined,
      venue: r.venue ?? undefined,
      city: r.city ?? undefined,
      region: r.region ?? undefined,
      country: r.country ?? undefined,
      sources: r.sources ?? {},
      details: r.details ?? { status: 'pending', candidates: [], notes: [] },
      lineupJobId: r.lineup_job_id ?? undefined,
      editionId: r.edition_id ?? undefined,
      seen: r.seen ?? [],
      kind: r.kind ?? undefined,
      format: r.format ?? undefined,
      series: r.series ?? undefined,
      weekend: r.weekend ?? undefined,
      attendance: r.attendance ?? undefined,
      weather: r.weather ?? undefined,
      daysAttended: r.days_attended ?? [],
      companions: r.companions ?? [],
      rating: r.rating ?? undefined,
      ticketPrice: r.ticket_price ?? undefined,
      notes: r.notes ?? undefined,
      personIds: r.person_ids?.length ? r.person_ids : undefined,
      captured: r.captured ?? undefined,
      overrides: r.overrides && Object.keys(r.overrides).length ? r.overrides : undefined,
      refs:
        r.companion_ids != null
          ? { venueId: r.venue_id ?? null, placeId: r.place_id ?? null, seriesId: r.series_id ?? null, companionIds: r.companion_ids }
          : undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at ?? undefined,
    });
  }

  // A save never touches deleted_at: only delete and restore change it.
  async putEvent(e: LoggedEvent) {
    await this.putEvents([e]);
  }

  async putEvents(list: LoggedEvent[]) {
    if (!list.length) return;
    const before = await this.priorEvents(list.map((e) => e.id));
    this.check(await this.own('logged_events').upsert(list.map((e) => this.stamp(this.eventToRow(e)))), 'putEvents');
    const now = new Date().toISOString();
    await this.writeActivity(
      list.flatMap((e) => {
        const { seriesKind: _seriesKind, ...cleanAfter } = splitEventCity(e);
        return diffEvent(before.get(e.id) ?? null, cleanAfter, isCiphertext);
      }),
      now,
    );
  }

  async getEvent(id: string) {
    const r = this.check(await this.mine(this.own('logged_events').select('*').eq('id', id).is('deleted_at', null)).maybeSingle(), 'getEvent');
    return r ? this.rowToEvent(r) : null;
  }

  async listEvents() {
    const rows = this.check(await this.mine(this.own('logged_events').select('*').is('deleted_at', null)), 'listEvents');
    return (rows ?? []).map((r: any) => this.rowToEvent(r));
  }

  async listPendingResearchEvents(limit = 50): Promise<LoggedEvent[]> {
    const rows = this.check(
      await this.mine(
        this.own('logged_events')
          .select('*')
          .is('deleted_at', null)
          .eq('details->>status', 'pending')
          .limit(limit),
      ),
      'listPendingResearchEvents',
    );
    return (rows ?? []).map((r: any) => this.rowToEvent(r));
  }

  async listSeenArtistNames(): Promise<string[]> {
    const names: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await this.mine(
        this.own('logged_events')
          .select('seen')
          .is('deleted_at', null)
          .order('id', { ascending: true })
      ).range(from, from + 999);
      if (error) throw new Error(`Supabase listSeenArtistNames failed: ${error.message}`);
      const rows = data ?? [];
      for (const r of rows) {
        const seen = Array.isArray(r.seen) ? r.seen : [];
        for (const a of seen) {
          if (a && typeof a.name === 'string' && a.name.trim()) names.push(a.name.trim());
        }
      }
      if (rows.length < 1000) break;
    }
    return names;
  }

  // Delete moves the show to Recently deleted. The nightly job erases it after 90 days.
  async deleteEvent(id: string) {
    const now = new Date().toISOString();
    const r = this.check(await this.mine(this.own('logged_events').select('id').eq('id', id).is('deleted_at', null)).maybeSingle(), 'deleteEvent');
    if (!r) return;
    this.check(await this.mine(this.own('logged_events').update({ deleted_at: now }).eq('id', id)), 'deleteEvent');
    await this.writeActivity([{ eventId: id, action: 'delete', field: null, before: null, after: null, sensitive: false }], now);
  }

  async restoreEvent(id: string) {
    const now = new Date().toISOString();
    const r = this.check(await this.mine(this.own('logged_events').select('id').eq('id', id).not('deleted_at', 'is', null)).maybeSingle(), 'restoreEvent');
    if (!r) return false;
    this.check(await this.mine(this.own('logged_events').update({ deleted_at: null }).eq('id', id)), 'restoreEvent');
    await this.writeActivity([{ eventId: id, action: 'restore', field: null, before: null, after: null, sensitive: false }], now);
    return true;
  }

  async eraseDeletedEvent(id: string) {
    const rows = this.check(await this.mine(this.own('logged_events').delete().eq('id', id).not('deleted_at', 'is', null).select('id')), 'eraseDeletedEvent');
    return (rows ?? []).length > 0;
  }

  async emptyTrash() {
    const rows = this.check(await this.mine(this.own('logged_events').delete().not('deleted_at', 'is', null).select('id')), 'emptyTrash');
    return (rows ?? []).length;
  }

  async listDeletedEvents() {
    const rows = this.check(await this.mine(this.own('logged_events').select('*').not('deleted_at', 'is', null)), 'listDeletedEvents');
    return (rows ?? []).map((r: any) => this.rowToEvent(r));
  }

  // Erases Recently deleted shows older than the cutoff. Run by the nightly job, never from a member's scope.
  async purgeDeletedEvents(olderThan: string) {
    if (this.scope) return 0;
    const rows = this.check(await this.own('logged_events').delete().not('deleted_at', 'is', null).lt('deleted_at', olderThan).select('id'), 'purgeDeletedEvents');
    return (rows ?? []).length;
  }

  async listActivity(limit: number): Promise<ActivityEntry[]> {
    const rows = this.check(await this.mine(this.own('activity_log').select('id,event_id,action,field,before_value,after_value,sensitive,created_at').order('created_at', { ascending: false }).limit(limit)), 'listActivity');
    return (rows ?? []).map((r: any) => ({
      id: r.id,
      eventId: r.event_id ?? null,
      action: r.action,
      field: r.field ?? null,
      before: r.before_value ?? null,
      after: r.after_value ?? null,
      sensitive: Boolean(r.sensitive),
      at: r.created_at,
    }));
  }

  // Erases Log rows older than the cutoff. Run by the nightly job; a member's scope never erases the Log.
  async purgeActivity(olderThan: string) {
    if (this.scope) return 0;
    const rows = this.check(await this.own('activity_log').delete().lt('created_at', olderThan).select('id'), 'purgeActivity');
    return (rows ?? []).length;
  }

  private async priorEvents(ids: string[]) {
    const rows = this.check(await this.mine(this.own('logged_events').select('*').in('id', ids)), 'priorEvents');
    return new Map((rows ?? []).map((r: any) => [r.id as string, this.rowToEvent(r)]));
  }

  // The Log rows for one save or one delete. Field values for sensitive fields are already blank in the draft.
  private async writeActivity(drafts: ActivityDraft[], at: string) {
    if (!drafts.length) return;
    const rows = drafts.map((d) =>
      this.stamp({
        event_id: d.eventId,
        action: d.action,
        field: d.field,
        before_value: d.before ?? null,
        after_value: d.after ?? null,
        sensitive: d.sensitive,
        created_at: at,
      }),
    );
    this.check(await this.own('activity_log').insert(rows), 'activity log');
  }

  // email_imports (0004) is optional: the app starts without it and only
  // email import asks for the migration.
  async listImports() {
    const rows = this.check(await this.mine(this.own('email_imports').select('data')), 'listImports (apply 0004_email_imports.sql)');
    return (rows ?? []).map((r: any) => r.data as EmailImport);
  }

  async putImports(rows: EmailImport[]) {
    if (!rows.length) return;
    this.check(
      await this.own('email_imports').upsert(
        rows.map((r) => this.stamp({ id: r.id, key: r.key, status: r.status, start_date: r.startDate ?? null, data: r, updated_at: r.updatedAt })),
      ),
      'putImports (apply 0004_email_imports.sql)',
    );
  }

  // app_settings (0006) is optional too: only "Check email" needs it.
  async getSetting<T>(key: string) {
    if (this.scope) {
      const own = this.check(
        await this.own('user_settings').select('data').eq('user_id', this.scope.userId).eq('key', key).maybeSingle(),
        'getSetting (apply 0017_members_and_user_id.sql)',
      );
      if (own) return (own as any).data as T;
      // The owner's settings from before multi-user live in app_settings.
      if (this.scope.role !== 'owner') return null;
    }
    const row = this.check(
      await this.db.from('app_settings').select('data').eq('key', key).maybeSingle(),
      'getSetting (apply 0006_app_settings.sql)',
    );
    return row ? ((row as any).data as T) : null;
  }

  async putSetting<T>(key: string, data: T) {
    if (this.scope) {
      this.check(
        await this.own('user_settings').upsert({ user_id: this.scope.userId, key, data, updated_at: new Date().toISOString() }),
        'putSetting (apply 0017_members_and_user_id.sql)',
      );
      return;
    }
    this.check(
      await this.db.from('app_settings').upsert({ key, data, updated_at: new Date().toISOString() }),
      'putSetting (apply 0006_app_settings.sql)',
    );
  }

  async listUserSettingsByKeys(keys: string[]): Promise<Array<{ userId: string; key: string; data: unknown }>> {
    if (!keys.length) return [];
    const out: Array<{ userId: string; key: string; data: unknown }> = [];
    for (let from = 0; ; from += 1000) {
      const page = this.check(
        await this.db.from('user_settings').select('user_id, key, data').in('key', keys).order('user_id').order('key').range(from, from + 999),
        'listUserSettingsByKeys (apply 0017_members_and_user_id.sql)',
      ) as any[] | null;
      for (const r of page ?? []) out.push({ userId: r.user_id, key: r.key, data: r.data });
      if ((page ?? []).length < 1000) break;
    }
    return out;
  }

  async listPendingResearchUserIds(): Promise<string[]> {
    const rows = this.check(
      await this.db
        .from('logged_events')
        .select('user_id')
        .is('deleted_at', null)
        .eq('details->>status', 'pending')
        .limit(500),
      'listPendingResearchUserIds',
    ) as any[] | null;
    return [...new Set((rows ?? []).map((r: any) => r.user_id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))];
  }

  async getArtist(key: string) {
    const r = this.check(await this.db.from('canonical_artists').select('*').eq('key', key).maybeSingle(), 'getArtist');
    return r ? { key: r.key, name: r.name, mbid: r.mbid ?? undefined, resolvedAt: r.resolved_at ?? undefined } : null;
  }

  async getArtists(keys: string[]) {
    const out: ArtistIdentity[] = [];
    // In chunks, so the query string stays short.
    for (let i = 0; i < keys.length; i += 200) {
      const rows = this.check(
        await this.db.from('canonical_artists').select('*').in('key', keys.slice(i, i + 200)),
        'getArtists',
      );
      for (const r of (rows ?? []) as any[]) out.push({ key: r.key, name: r.name, mbid: r.mbid ?? undefined, resolvedAt: r.resolved_at ?? undefined });
    }
    return out;
  }

  async ensureArtists(list: ArtistIdentity[]) {
    const rows = [...new Map(list.map((a) => [a.key, { key: a.key, name: a.name }])).values()];
    if (!rows.length) return;
    this.check(
      await this.db.from('canonical_artists').upsert(rows, { onConflict: 'key', ignoreDuplicates: true }),
      'ensureArtists',
    );
  }

  async upsertArtist(a: ArtistIdentity) {
    const res = await this.db
      .from('canonical_artists')
      .upsert({ key: a.key, name: a.name, mbid: a.mbid ?? null, resolved_at: a.resolvedAt ?? null });
    const err = res.error as { code?: string; message: string } | null;
    if (err && a.mbid && err.code === '23505' && /mbid/.test(err.message)) throw new ArtistIdTakenError(a.key, a.mbid);
    this.check(res, 'upsertArtist');
  }

  // Counts come from the canonical_community_counts() function (migration 0033),
  // which returns only a name key and a number.
  async communityCounts(): Promise<Map<string, number> | null> {
    const { data, error } = await this.db.rpc('canonical_community_counts');
    if (error) throw new Error(`Supabase communityCounts failed: ${error.message}`);
    return new Map((data ?? []).map((r: { name_key: string; member_count: number }) => [r.name_key, r.member_count]));
  }

  async listArtists() {
    const out: ArtistIdentity[] = [];
    for (let from = 0; ; from += 1000) {
      const rows = this.check(
        await this.db.from('canonical_artists').select('*').order('key').range(from, from + 999),
        'listArtists',
      );
      for (const r of (rows ?? []) as any[]) out.push({ key: r.key, name: r.name, mbid: r.mbid ?? undefined, resolvedAt: r.resolved_at ?? undefined });
      if (!rows || rows.length < 1000) break;
    }
    return out;
  }

  async deleteArtists(keys: string[]) {
    if (keys.length) this.check(await this.db.from('canonical_artists').delete().in('key', keys), 'deleteArtists');
  }

  async artistPerformances(keys: string[]): Promise<ArtistPerformanceRow[]> {
    const out: ArtistPerformanceRow[] = [];
    for (let i = 0; i < keys.length; i += 200) {
      const rows = this.check(
        await this.db.from('performances').select('*').in('artist_key', keys.slice(i, i + 200)),
        'artistPerformances',
      );
      for (const r of (rows ?? []) as any[]) out.push({ id: r.id, editionId: r.edition_id, ...this.toPerformance(r) });
    }
    return out;
  }

  // Canonical artist apply and Undo (migration 0037). The RPCs check the owner, the fingerprint and the
  // current state themselves, under row locks. This side sends named parameters and maps the error codes.
  // A member scope is refused here too, because a service-role call skips the SQL owner check.
  private canonicalClient(): SupabaseClient {
    if (this.scope && this.scope.role !== 'owner') throw new CanonicalStoreError('forbidden', 'Only the owner can do this.');
    return this.scope?.db ?? this.db;
  }

  private canonicalUserId(): string | null {
    return this.scope ? this.scope.userId : null;
  }

  private canonicalRpcError(error: { code?: string; message: string }, what: string): CanonicalStoreError {
    if (error.code === 'P0409') return new CanonicalStoreError('stale', error.message);
    if (error.code === '42501') return new CanonicalStoreError('forbidden', error.message);
    return new CanonicalStoreError('generic', `Supabase ${what} failed: ${error.message}`);
  }

  async canonicalArtistFingerprint(entry: SqlCanonicalEntry): Promise<string> {
    const { data, error } = await this.canonicalClient().rpc('canonical_artist_fingerprint', {
      p_entry: entry,
      p_user_id: this.canonicalUserId(),
    });
    if (error) throw this.canonicalRpcError(error, 'canonical_artist_fingerprint');
    if (typeof data !== 'string') throw new CanonicalStoreError('generic', 'Supabase canonical_artist_fingerprint returned no fingerprint.');
    return data;
  }

  async applyCanonicalArtistChange(entry: SqlCanonicalEntry, fingerprint: string): Promise<CanonicalApplyResult> {
    const { data, error } = await this.canonicalClient().rpc('canonical_apply_artist_change', {
      p_fingerprint: fingerprint,
      p_entry: entry,
      p_user_id: this.canonicalUserId(),
    });
    if (error) throw this.canonicalRpcError(error, 'canonical_apply_artist_change');
    return data as CanonicalApplyResult;
  }

  async undoCanonicalArtistChange(historyId: string): Promise<CanonicalUndoResult> {
    const { data, error } = await this.canonicalClient().rpc('canonical_undo_artist_change', {
      p_history_id: historyId,
      p_user_id: this.canonicalUserId(),
    });
    if (error) throw this.canonicalRpcError(error, 'canonical_undo_artist_change');
    return data as CanonicalUndoResult;
  }

  // performances is keyed by `id` (migration 0029 replaced the (edition_id, artist_key) key), so there is no
  // unique constraint for an ON CONFLICT upsert. Replace each artist's rows in the given editions instead:
  // delete per artist key and chunk of editions, then insert the full rows.
  async putArtistPerformances(rows: ArtistEditionRow[]) {
    if (!rows.length) return;
    const byKey = new Map<string, ArtistEditionRow[]>();
    for (const r of rows) byKey.set(r.artistKey, [...(byKey.get(r.artistKey) ?? []), r]);
    for (const [artistKey, group] of byKey) {
      const editionIds = [...new Set(group.map((r) => r.editionId))];
      for (let i = 0; i < editionIds.length; i += 200) {
        this.check(
          await this.db.from('performances').delete().eq('artist_key', artistKey).in('edition_id', editionIds.slice(i, i + 200)),
          'putArtistPerformances clear',
        );
      }
      const inserts = group.map((r) => this.performanceRow(r.editionId, r));
      for (let i = 0; i < inserts.length; i += 200) {
        this.check(await this.db.from('performances').insert(inserts.slice(i, i + 200)), 'putArtistPerformances');
      }
    }
  }

  // One delete per artist key and chunk of editions, so a merge stays within a Worker's subrequest limit.
  async deleteArtistPerformances(rows: Array<{ editionId: string; artistKey: string }>) {
    const byKey = new Map<string, string[]>();
    for (const r of rows) byKey.set(r.artistKey, [...(byKey.get(r.artistKey) ?? []), r.editionId]);
    for (const [artistKey, editionIds] of byKey) {
      for (let i = 0; i < editionIds.length; i += 200) {
        this.check(
          await this.db.from('performances').delete().eq('artist_key', artistKey).in('edition_id', editionIds.slice(i, i + 200)),
          'deleteArtistPerformances',
        );
      }
    }
  }

  async listUnresolvedArtists(limit: number) {
    const rows = this.check(
      await this.db.from('canonical_artists').select('*').is('resolved_at', null).limit(limit),
      'listUnresolvedArtists',
    );
    return (rows ?? []).map((r: any): ArtistIdentity => ({ key: r.key, name: r.name, mbid: r.mbid ?? undefined }));
  }

  // artist_genres (0013) is optional: only genres need it.
  // A member (not the owner) keeps only genres they set themselves, in
  // user_artist_genres (0020); the shared artist_genres come from the owner's
  // music-story export.
  private get memberGenres(): boolean {
    return Boolean(this.scope && this.scope.role !== 'owner');
  }

  async listArtistGenres() {
    if (this.memberGenres) {
      const own = this.check(await this.mine(this.own('user_artist_genres').select('*')), 'listArtistGenres (apply 0020_per_member_entities.sql)');
      return ((own ?? []) as any[]).map((r): ArtistGenres => ({ key: r.artist_key, name: r.name, source: 'you', genres: r.genres ?? [], checkedAt: r.updated_at }));
    }
    const rows = this.check(await this.db.from('artist_genres').select('*'), 'listArtistGenres (apply 0013_artist_genres.sql)');
    return ((rows ?? []) as any[]).map(
      (r): ArtistGenres => ({
        key: r.artist_key,
        name: r.name,
        source: r.source,
        mbid: r.mbid ?? undefined,
        genres: r.genres ?? [],
        sourceUrl: r.source_url ?? undefined,
        inputs: r.inputs?.length ? r.inputs : undefined,
        checkedAt: r.checked_at,
      }),
    );
  }

  // Entities (0014) -------------------------------------------------------

  // A member's records live in their own tables (0020): user_entities and
  // friends, each row carrying user_id. The single-owner app keeps using the
  // shared ones. Reads go through the member's token, so row level security
  // is a second lock; writes stamp user_id.
  private ent(shared: string) {
    return this.scope ? this.own(`user_${shared}`) : this.db.from(shared);
  }

  // Every row of a table, a page at a time (PostgREST returns 1000 at most).
  private async all(shared: string, what: string): Promise<any[]> {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const rows = this.check(await this.mine(this.ent(shared).select('*')).range(from, from + 999), what) ?? [];
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  // An alias is a normalized name, or for an encrypted person a name token.
  private get aliasCol() {
    return this.scope ? 'companion_token' : 'alias_normalized';
  }

  private entityFromRow(r: any): Entity {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      nameNormalized: r.name_normalized,
      ...(r.name_encrypted ? { nameEncrypted: r.name_encrypted } : {}),
      attrs: r.attrs ?? {},
      mergedIntoId: r.merged_into_id ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private entityRow(e: Entity) {
    return this.stamp({
      id: e.id,
      kind: e.kind,
      name: e.name,
      name_normalized: e.nameNormalized,
      ...(this.scope ? { name_encrypted: e.nameEncrypted ?? null } : {}),
      attrs: e.attrs,
      merged_into_id: e.mergedIntoId ?? null,
      created_at: e.createdAt,
      updated_at: e.updatedAt,
    });
  }

  private aliasRow(a: EntityAlias) {
    return this.stamp({ entity_id: a.entityId, kind: a.kind, [this.aliasCol]: a.aliasNormalized });
  }

  private get entityConflict() {
    return this.scope ? 'user_id,id' : 'id';
  }

  async listEntities() {
    return (await this.all('entities', 'listEntities')).map((r) => this.entityFromRow(r));
  }

  async putArtistGenres(rows: ArtistGenres[]) {
    if (this.memberGenres) {
      if (rows.some((r) => r.source !== 'you')) throw new Error('A member can only keep genres they set themselves.');
      const chunk = rows.map((r) => this.stamp({ artist_key: r.key, name: r.name, genres: r.genres, updated_at: r.checkedAt }));
      if (chunk.length) this.check(await this.own('user_artist_genres').upsert(chunk, { onConflict: 'user_id,artist_key' }), 'putArtistGenres (apply 0020_per_member_entities.sql)');
      return;
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({
        artist_key: r.key,
        source: r.source,
        name: r.name,
        mbid: r.mbid ?? null,
        genres: r.genres,
        source_url: r.sourceUrl ?? null,
        inputs: r.inputs ?? [],
        checked_at: r.checkedAt,
      }));
      if (chunk.length) this.check(await this.db.from('artist_genres').upsert(chunk), 'putArtistGenres (apply 0013_artist_genres.sql)');
    }
  }

  async deleteArtistGenres(key: string, source: ArtistGenres['source']) {
    if (this.memberGenres) {
      if (source === 'you') this.check(await this.mine(this.own('user_artist_genres').delete().eq('artist_key', key)), 'deleteArtistGenres');
      return;
    }
    this.check(
      await this.db.from('artist_genres').delete().eq('artist_key', key).eq('source', source),
      'deleteArtistGenres (apply 0013_artist_genres.sql)',
    );
  }

  // The live-name, self-merge and missing-target rules are constraints in
  // 0014 and 0020; flattening is kept by the only code that merges.
  async addEntities(list: Entity[]) {
    const rows = [...new Map(list.map((e) => [e.id, e])).values()].map((e) => this.entityRow(e));
    if (rows.length) this.check(await this.ent('entities').upsert(rows, { onConflict: this.entityConflict, ignoreDuplicates: true }), 'addEntities');
  }

  async listEntityAliases() {
    return (await this.all('entity_aliases', 'listEntityAliases')).map(
      (r): EntityAlias => ({ entityId: r.entity_id, kind: r.kind, aliasNormalized: r[this.aliasCol] }),
    );
  }

  // unique (kind, alias) rejects an alias another record holds.
  async addEntityAliases(list: EntityAlias[]) {
    const rows = [...new Map(list.map((a) => [`${a.kind}\u0000${a.aliasNormalized}`, a])).values()];
    const existing = new Map((await this.listEntityAliases()).map((a) => [`${a.kind}\u0000${a.aliasNormalized}`, a.entityId]));
    const fresh = rows.filter((a) => {
      const held = existing.get(`${a.kind}\u0000${a.aliasNormalized}`);
      if (held && held !== a.entityId) throw new Error(`Supabase addEntityAliases failed: the ${a.kind} alias "${a.aliasNormalized}" already belongs to another record.`);
      return !held;
    });
    if (fresh.length) this.check(await this.ent('entity_aliases').insert(fresh.map((a) => this.aliasRow(a))), 'addEntityAliases');
  }

  async listEntityLinks() {
    return (await this.all('entity_links', 'listEntityLinks')).map(
      (r): EntityLink => ({ fromId: r.from_id, toId: r.to_id, role: r.role, createdAt: r.created_at }),
    );
  }

  // Postgres checks the ends exist and differ; which kinds may link how is
  // checked here, as in the file store.
  async addEntityLinks(list: EntityLink[]) {
    if (!list.length) return;
    const ids = [...new Set(list.flatMap((l) => [l.fromId, l.toId]))];
    const rows = this.check(await this.mine(this.ent('entities').select('*').in('id', ids)), 'addEntityLinks') ?? [];
    checkLinks(new Map(rows.map((r: any): [string, Entity] => [r.id, this.entityFromRow(r)])), list);
    this.check(
      await this.ent('entity_links').upsert(
        list.map((l) => this.stamp({ from_id: l.fromId, to_id: l.toId, role: l.role, created_at: l.createdAt })),
        { onConflict: this.scope ? 'user_id,from_id,to_id,role' : 'from_id,to_id,role', ignoreDuplicates: true },
      ),
      'addEntityLinks',
    );
  }

  // Merge targets first, so a record is never written merged into one
  // that is not there yet.
  async putEntities(list: Entity[]) {
    if (!list.length) return;
    const rows = [...list].sort((a, b) => Number(Boolean(a.mergedIntoId)) - Number(Boolean(b.mergedIntoId))).map((e) => this.entityRow(e));
    this.check(await this.ent('entities').upsert(rows, { onConflict: this.entityConflict }), 'putEntities');
  }

  // Not one transaction: the delete and the insert are two requests. The
  // history entry written before them holds what to put back.
  async replaceEntityAliases(entityIds: string[], aliases: EntityAlias[]) {
    if (entityIds.length) this.check(await this.mine(this.ent('entity_aliases').delete().in('entity_id', entityIds)), 'replaceEntityAliases');
    const rows = [...new Map(aliases.map((a) => [`${a.kind}\u0000${a.aliasNormalized}`, a])).values()];
    if (rows.length) this.check(await this.ent('entity_aliases').insert(rows.map((a) => this.aliasRow(a))), 'replaceEntityAliases');
  }

  async replaceEntityLinks(entityIds: string[], links: EntityLink[]) {
    if (entityIds.length) {
      if (!entityIds.every((id) => /^[A-Za-z0-9_-]+$/.test(id))) throw new Error('Invalid entity id');
      const ids = entityIds.join(',');
      this.check(await this.mine(this.ent('entity_links').delete().or(`from_id.in.(${ids}),to_id.in.(${ids})`)), 'replaceEntityLinks');
    }
    await this.addEntityLinks(links);
  }

  async deleteEntities(ids: string[]) {
    if (!ids.length) return;
    if (!this.scope) throw new Error('Records are only deleted from a member\'s own tables.');
    // Their aliases and links go with them (on delete cascade, 0020).
    this.check(await this.mine(this.ent('entities').delete().in('id', ids)), 'deleteEntities');
  }

  async deleteEntityHistory(ids: string[]) {
    if (ids.length) this.check(await this.mine(this.ent('entity_history').delete().in('id', ids)), 'deleteEntityHistory');
  }

  async putEntityHistory(h: HistoryEntry) {
    this.check(
      await this.ent('entity_history').upsert(
        this.stamp({ id: h.id, operation: h.operation, manifest: h, created_at: h.createdAt, undone_at: h.undoneAt ?? null }),
        { onConflict: this.entityConflict },
      ),
      'putEntityHistory',
    );
  }

  async getEntityHistory(id: string) {
    const r = this.check(await this.mine(this.ent('entity_history').select('manifest').eq('id', id)).maybeSingle(), 'getEntityHistory');
    return r ? ((r as any).manifest as HistoryEntry) : null;
  }

  async listEntityHistory(limit: number) {
    const rows = this.check(
      await this.mine(this.ent('entity_history').select('manifest')).order('created_at', { ascending: false }).limit(limit),
      'listEntityHistory',
    );
    return (rows ?? []).map((r: any) => r.manifest as HistoryEntry);
  }

  // Canonical operations only, newest first. The operation filter and the keyset condition are
  // part of the same query as the limit, so the page is filled from canonical rows only. Named columns only.
  async listCanonicalHistoryPage(options: CanonicalHistoryPageOptions = {}): Promise<CanonicalHistoryPage> {
    const limit = normalizeCanonicalHistoryLimit(options.limit);
    const cursor = options.cursor == null ? null : decodeCanonicalHistoryCursor(options.cursor);
    let query: any = this.mine(this.ent('entity_history').select('id, operation, created_at, undone_at, manifest'))
      .in('operation', [...CANONICAL_OPERATIONS])
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (cursor) {
      // Strictly older than (created_at, id): the cursor's values passed the fixed-character checks in decodeCanonicalHistoryCursor.
      query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    }
    const rows = this.check(await query.limit(limit + 1), 'listCanonicalHistoryPage') ?? [];
    const list = rows as Array<{ id: string; operation: string; created_at: string; undone_at: string | null; manifest: unknown }>;
    const entries: CanonicalHistoryEntry[] = list.slice(0, limit).map((r) => {
      if (!isCanonicalOperation(r.operation)) throw new Error(`Supabase listCanonicalHistoryPage returned a non-canonical operation: ${r.operation}`);
      return {
        id: r.id,
        operation: r.operation,
        createdAt: r.created_at,
        ...(r.undone_at ? { undoneAt: r.undone_at } : {}),
        manifest: r.manifest,
      };
    });
    const last = entries[entries.length - 1];
    return {
      entries,
      nextCursor: list.length > limit && last ? encodeCanonicalHistoryCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  // source_response_cache (0019) is optional: without it nothing is cached.
  async getCachedResponse(key: string, now: Date) {
    const { data, error } = await this.db.from('source_response_cache').select('*').eq('key', key).gt('expires_at', now.toISOString()).maybeSingle();
    if (error || !data) return null;
    const r = data as any;
    return { key: r.key, sourceType: r.source_type, status: r.status, body: r.body, fetchedAt: r.fetched_at, expiresAt: r.expires_at };
  }

  async putCachedResponse(e: CachedResponse) {
    // Expired rows are removed as new ones arrive, so the table stays small.
    await this.db.from('source_response_cache').delete().lt('expires_at', e.fetchedAt);
    await this.db.from('source_response_cache').upsert({
      key: e.key, source_type: e.sourceType, status: e.status, body: e.body, fetched_at: e.fetchedAt, expires_at: e.expiresAt,
    });
  }

  // share_links (0015) is optional: only the share page needs it.
  async listShareLinks() {
    const rows = this.check(await this.mine(this.own('share_links').select('*')), 'listShareLinks (apply 0015_share_links.sql)');
    return (rows ?? []).map(rowToShareLink);
  }

  async getShareLinkByHash(codeHash: string) {
    const r = this.check(
      await this.mine(this.own('share_links').select('*').eq('code_hash', codeHash)).maybeSingle(),
      'getShareLinkByHash (apply 0015_share_links.sql)',
    );
    return r ? rowToShareLink(r) : null;
  }

  async putShareLink(l: ShareLink) {
    this.check(
      await this.own('share_links').upsert(
        this.stamp({
          id: l.id,
          code_hash: l.codeHash,
          settings: l.settings,
          created_at: l.createdAt,
          revoked_at: l.revokedAt ?? null,
          ...(l.userId ? { user_id: l.userId } : {}),
        }),
      ),
      'putShareLink (apply 0015_share_links.sql)',
    );
  }

  // Only the named columns are read, so private fields never leave the
  // database for the share page.
  async listShareEvents() {
    const rows = this.check(await this.mine(this.own('logged_events').select(SHARE_EVENT_COLUMNS.join(',')).is('deleted_at', null)), 'listShareEvents');
    return (rows ?? []).map((r: any) => this.rowToEvent(r));
  }

  // AI call log (0038). Server-side only (service role), so the unscoped client is used. One insert per call.
  async addAiCall(r: AiCallRow): Promise<void> {
    this.check(
      await this.db.from('ai_calls').insert({
        id: r.id,
        created_at: r.createdAt,
        feature: r.feature,
        job_id: r.jobId,
        event_id: r.eventId,
        user_id: r.userId,
        provider: r.provider,
        model: r.model,
        source_document_id: r.sourceDocumentId,
        input_chars: r.inputChars,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        est_cost_usd: r.estCostUsd,
        duration_ms: r.durationMs,
        outcome: r.outcome,
        error_code: r.errorCode,
        guard_reason: r.guardReason,
        names_returned: r.namesReturned,
        names_verbatim: r.namesVerbatim,
        names_rejected: r.namesRejected,
      }),
      'addAiCall (apply 0038_ai_calls.sql)',
    );
  }

  // Guard and settle in one database call each (0040_reader_rpcs.sql). Service client only, never the member's.
  // Errors throw; src/server/reader/guard.ts turns them into a parked job (guard_unavailable), never a fallback.
  async readerPreflight(args: Record<string, unknown>): Promise<PreflightReply> {
    const { data, error } = await this.db.rpc('reader_preflight', { p_args: args });
    if (error) throw new Error(`readerPreflight (apply 0040_reader_rpcs.sql): ${error.message}`);
    return data as PreflightReply;
  }

  async readerSettle(args: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.rpc('reader_settle', { p_args: args });
    if (error) throw new Error(`readerSettle (apply 0040_reader_rpcs.sql): ${error.message}`);
  }

  async listAiCalls(limit: number): Promise<AiCallRow[]> {
    const rows = this.check(
      await this.db.from('ai_calls').select('*').order('created_at', { ascending: false }).limit(limit),
      'listAiCalls (apply 0038_ai_calls.sql)',
    );
    return (rows ?? []).map(rowToAiCall);
  }

  // Ingest traces (0043). Service client; one insert per message.
  async addIngestTrace(r: IngestTraceRow): Promise<void> {
    this.check(
      await this.db.from('ingest_traces').insert({
        id: r.id,
        trigger: r.trigger,
        event_id: r.eventId,
        edition_id: r.editionId,
        job_id: r.jobId,
        steps: r.steps,
        subrequests: r.subrequests,
        ai_cost_micros: r.aiCostMicros,
        created_at: r.createdAt,
      }),
      'addIngestTrace (apply 0043_ingest_traces.sql)',
    );
  }

  async listIngestTraces(limit: number): Promise<IngestTraceRow[]> {
    const rows = this.check(
      await this.db.from('ingest_traces').select('*').order('created_at', { ascending: false }).limit(limit),
      'listIngestTraces (apply 0043_ingest_traces.sql)',
    );
    return (rows ?? []).map((r: any) => ({
      id: r.id,
      trigger: r.trigger,
      eventId: r.event_id ?? null,
      editionId: r.edition_id ?? null,
      jobId: r.job_id ?? null,
      steps: r.steps ?? [],
      subrequests: r.subrequests ?? null,
      aiCostMicros: r.ai_cost_micros ?? null,
      createdAt: r.created_at,
    }));
  }

  async deleteAiCallsBefore(cutoff: Date): Promise<number> {
    const res: any = await this.db.from('ai_calls').delete({ count: 'exact' }).lt('created_at', cutoff.toISOString());
    this.check(res, 'deleteAiCallsBefore (apply 0038_ai_calls.sql)');
    return res.count ?? 0;
  }

  // Shared occurrences (0041, 0042). Service client only, like the AI call log: members never write these tables.
  async upsertVenue(v: { name: string; city?: string; region?: string; country?: string }): Promise<CanonicalVenue> {
    const id = venueIdFor(v, normalizeName);
    this.check(
      await this.db.from('canonical_venues').upsert(
        { id, name: v.name, city: v.city ?? null, region: v.region ?? null, country: v.country ?? null },
        { onConflict: 'id', ignoreDuplicates: true },
      ),
      'upsertVenue (apply 0041_shared_occurrences.sql)',
    );
    let row = this.check(await this.db.from('canonical_venues').select('*').eq('id', id).maybeSingle(), 'upsertVenue');
    if (!row) throw new Error('Supabase upsertVenue failed: venue not found after insert');
    const region = v.region?.trim();
    if (region && !(typeof row.region === 'string' && row.region.trim())) {
      this.check(await this.db.from('canonical_venues').update({ region }).eq('id', id).is('region', null), 'upsertVenue region');
      row = { ...row, region };
    }
    await this.addVenueAlias(id, normalizeName(v.name));
    return rowToVenue(row);
  }

  async listVenuesByAlias(aliasNormalized: string): Promise<CanonicalVenue[]> {
    const hits = this.check(await this.db.from('venue_aliases').select('venue_id').eq('alias_normalized', aliasNormalized), 'listVenuesByAlias (apply 0041_shared_occurrences.sql)') as any[] | null;
    const ids = [...new Set((hits ?? []).map((r) => r.venue_id as string))];
    if (!ids.length) return [];
    const rows = this.check(await this.db.from('canonical_venues').select('*').in('id', ids), 'listVenuesByAlias') as any[] | null;
    return (rows ?? []).map(rowToVenue);
  }

  async findVenueByAlias(aliasNormalized: string): Promise<CanonicalVenue | null> {
    const hits = this.check(await this.db.from('venue_aliases').select('venue_id').eq('alias_normalized', aliasNormalized), 'findVenueByAlias (apply 0041_shared_occurrences.sql)') as any[] | null;
    const ids = [...new Set((hits ?? []).map((r) => r.venue_id as string))];
    if (ids.length !== 1) return null;
    const row = this.check(await this.db.from('canonical_venues').select('*').eq('id', ids[0]).maybeSingle(), 'findVenueByAlias');
    return row ? rowToVenue(row) : null;
  }

  async addVenueAlias(venueId: string, aliasNormalized: string, source?: string, externalId?: string): Promise<void> {
    if (source && externalId) {
      const held = this.check(await this.db.from('venue_aliases').select('venue_id').eq('source', source).eq('external_id', externalId).maybeSingle(), 'addVenueAlias') as any;
      if (held && held.venue_id !== venueId) throw new ExternalIdConflictError(source, externalId, held.venue_id);
    }
    this.check(
      await this.db.from('venue_aliases').upsert(
        { venue_id: venueId, alias_normalized: aliasNormalized, source: source ?? null, external_id: externalId ?? null },
        { onConflict: 'alias_normalized,venue_id', ignoreDuplicates: true },
      ),
      'addVenueAlias (apply 0041_shared_occurrences.sql)',
    );
  }

  async findEditionByExternalId(source: string, externalId: string): Promise<Edition | null> {
    const hit = this.check(await this.db.from('edition_external_ids').select('edition_id').eq('source', source).eq('external_id', externalId).maybeSingle(), 'findEditionByExternalId (apply 0041_shared_occurrences.sql)') as any;
    return hit ? this.getEdition(hit.edition_id) : null;
  }

  async addEditionExternalId(editionId: string, source: string, externalId: string): Promise<'added' | 'exists'> {
    const held = this.check(await this.db.from('edition_external_ids').select('edition_id').eq('source', source).eq('external_id', externalId).maybeSingle(), 'addEditionExternalId (apply 0041_shared_occurrences.sql)') as any;
    if (held) {
      if (held.edition_id !== editionId) throw new ExternalIdConflictError(source, externalId, held.edition_id);
      return 'exists';
    }
    this.check(await this.db.from('edition_external_ids').insert({ edition_id: editionId, source, external_id: externalId }), 'addEditionExternalId');
    return 'added';
  }

  async recordEditionChange(c: { editionId: string; actor: string; reason?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }): Promise<EditionChange> {
    assertNoPersonalFields(c.before);
    assertNoPersonalFields(c.after);
    const row: EditionChange = { id: crypto.randomUUID(), editionId: c.editionId, at: new Date().toISOString(), actor: c.actor || 'system', reason: c.reason, before: c.before, after: c.after };
    this.check(
      await this.db.from('edition_changes').insert({
        id: row.id, edition_id: row.editionId, at: row.at, actor: row.actor, reason: row.reason ?? null, before: row.before ?? null, after: row.after ?? null,
      }),
      'recordEditionChange (apply 0041_shared_occurrences.sql)',
    );
    return row;
  }

  async listEditionChanges(editionId: string): Promise<EditionChange[]> {
    const rows = this.check(await this.db.from('edition_changes').select('*').eq('edition_id', editionId).order('at', { ascending: false }), 'listEditionChanges (apply 0041_shared_occurrences.sql)') as any[] | null;
    return (rows ?? []).map((r) => ({
      id: r.id, editionId: r.edition_id, at: r.at, actor: r.actor,
      reason: r.reason ?? undefined, before: r.before ?? undefined, after: r.after ?? undefined, undoneAt: r.undone_at ?? undefined,
    }));
  }

  async markChangeUndone(changeId: string): Promise<boolean> {
    const rows = this.check(
      await this.db.from('edition_changes').update({ undone_at: new Date().toISOString() }).eq('id', changeId).is('undone_at', null).select('id'),
      'markChangeUndone (apply 0041_shared_occurrences.sql)',
    ) as any[] | null;
    return (rows ?? []).length > 0;
  }

  async addEditionInference(i: NewEditionInference): Promise<EditionInference> {
    if (!i.reason || !i.reason.trim()) throw new Error('An inference needs a reason.');
    assertNoPersonalFields(i.value);
    assertNoPersonalFields(i.inputs);
    const row: EditionInference = { ...i, id: crypto.randomUUID(), status: 'active', createdAt: new Date().toISOString() };
    this.check(
      await this.db.from('edition_inferences').insert({
        id: row.id, edition_id: row.editionId, field: row.field, subject: row.subject ?? null, value: row.value ?? null, reason: row.reason, rule: row.rule,
        inputs: row.inputs, parents: row.parents, status: 'active', actor: row.actor, created_at: row.createdAt,
      }),
      'addEditionInference (apply 0055_edition_inferences.sql)',
    );
    return row;
  }

  async listEditionInferences(editionId: string): Promise<EditionInference[]> {
    const rows = this.check(await this.db.from('edition_inferences').select('*').eq('edition_id', editionId).order('created_at', { ascending: false }), 'listEditionInferences (apply 0055_edition_inferences.sql)') as any[] | null;
    return (rows ?? []).map(mapEditionInference);
  }

  async listInferenceChildren(id: string): Promise<EditionInference[]> {
    const rows = this.check(await this.db.from('edition_inferences').select('*').contains('parents', [id]).order('created_at', { ascending: false }), 'listInferenceChildren (apply 0055_edition_inferences.sql)') as any[] | null;
    return (rows ?? []).map(mapEditionInference);
  }

  async resolveEditionInference(id: string, r: { status: Exclude<InferenceStatus, 'active'>; by: string; reason: string }): Promise<EditionInference | null> {
    const rows = this.check(
      await this.db.from('edition_inferences').update({ status: r.status, resolved_at: new Date().toISOString(), resolved_by: r.by, resolved_reason: r.reason })
        .eq('id', id).eq('status', 'active').select('*'),
      'resolveEditionInference (apply 0055_edition_inferences.sql)',
    ) as any[] | null;
    return rows && rows.length ? mapEditionInference(rows[0]) : null;
  }

  async getEditionInference(id: string): Promise<EditionInference | null> {
    const rows = this.check(await this.db.from('edition_inferences').select('*').eq('id', id).limit(1), 'getEditionInference (apply 0055_edition_inferences.sql)') as any[] | null;
    return rows && rows.length ? mapEditionInference(rows[0]) : null;
  }

  async reactivateEditionInference(id: string, r: { by: string; reason: string }): Promise<EditionInference | null> {
    // The unique index refuses a second active row for the same slot; that error is raised to the caller.
    const rows = this.check(
      await this.db.from('edition_inferences').update({ status: 'active', resolved_at: null, resolved_by: null, resolved_reason: null })
        .eq('id', id).eq('status', 'confirmed').select('*'),
      `reactivateEditionInference (apply 0055_edition_inferences.sql) ${r.reason}`,
    ) as any[] | null;
    return rows && rows.length ? mapEditionInference(rows[0]) : null;
  }

  async listActiveInferences(): Promise<EditionInference[]> {
    const rows = this.check(
      await this.db.from('edition_inferences').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(200),
      'listActiveInferences (apply 0055_edition_inferences.sql)',
    ) as any[] | null;
    return (rows ?? []).map(mapEditionInference);
  }

  async addInferenceVote(inferenceId: string, memberId: string): Promise<InferenceVote> {
    const row = { id: crypto.randomUUID(), inference_id: inferenceId, member_id: memberId, created_at: new Date().toISOString() };
    // Upsert on the unique pair: a repeat tap changes nothing and returns the first vote.
    const rows = this.check(
      await this.db.from('inference_votes').upsert(row, { onConflict: 'inference_id,member_id', ignoreDuplicates: true }).select('*'),
      'addInferenceVote (apply 0057_inference_votes.sql)',
    ) as any[] | null;
    if (rows && rows.length) return mapInferenceVote(rows[0]);
    const existing = this.check(
      await this.db.from('inference_votes').select('*').eq('inference_id', inferenceId).eq('member_id', memberId).limit(1),
      'addInferenceVote (apply 0057_inference_votes.sql)',
    ) as any[] | null;
    return mapInferenceVote(existing![0]);
  }

  async listInferenceVotesFor(inferenceIds: string[]): Promise<InferenceVote[]> {
    const ids = [...new Set(inferenceIds)];
    const out: InferenceVote[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const rows = this.check(
        await this.db.from('inference_votes').select('*').in('inference_id', ids.slice(i, i + 100)).order('created_at', { ascending: true }),
        'listInferenceVotesFor (apply 0057_inference_votes.sql)',
      ) as any[] | null;
      out.push(...(rows ?? []).map(mapInferenceVote));
    }
    return out;
  }

  async listInferenceVotes(inferenceId: string): Promise<InferenceVote[]> {
    const rows = this.check(
      await this.db.from('inference_votes').select('*').eq('inference_id', inferenceId).order('created_at', { ascending: true }),
      'listInferenceVotes (apply 0057_inference_votes.sql)',
    ) as any[] | null;
    return (rows ?? []).map(mapInferenceVote);
  }

  async addReviewItem(i: { kind: ReviewQueueKind; editionId?: string; eventId?: string; payload: Record<string, unknown> }): Promise<ReviewQueueItem> {
    assertNoPersonalFields(i.payload);
    const row: ReviewQueueItem = { id: crypto.randomUUID(), kind: i.kind, editionId: i.editionId, eventId: i.eventId, payload: i.payload, status: 'open', createdAt: new Date().toISOString() };
    this.check(
      await this.db.from('review_queue').insert({
        id: row.id, kind: row.kind, edition_id: row.editionId ?? null, event_id: row.eventId ?? null, payload: row.payload, status: 'open', created_at: row.createdAt,
      }),
      'addReviewItem (apply 0041_shared_occurrences.sql)',
    );
    return row;
  }

  async enqueueReview(i: { kind: ReviewQueueKind; editionId?: string; eventId?: string; payload: Record<string, unknown> }): Promise<ReviewQueueItem> {
    return this.addReviewItem(i);
  }

  async listReviewItems(q: { status?: string; kind?: ReviewQueueKind } = {}): Promise<ReviewQueueItem[]> {
    let query = this.db.from('review_queue').select('*');
    if (q.status) query = query.eq('status', q.status);
    if (q.kind) query = query.eq('kind', q.kind);
    const rows = this.check(await query.order('created_at', { ascending: true }), 'listReviewItems (apply 0041_shared_occurrences.sql)') as any[] | null;
    return (rows ?? []).map((r) => ({
      id: r.id, kind: r.kind, editionId: r.edition_id ?? undefined, eventId: r.event_id ?? undefined, payload: r.payload ?? {},
      status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at ?? undefined, resolvedBy: r.resolved_by ?? undefined,
    }));
  }

  async resolveReviewItem(id: string, resolvedBy: string, status: string): Promise<boolean> {
    const rows = this.check(
      await this.db.from('review_queue').update({ status, resolved_by: resolvedBy, resolved_at: new Date().toISOString() }).eq('id', id).eq('status', 'open').select('id'),
      'resolveReviewItem (apply 0041_shared_occurrences.sql)',
    ) as any[] | null;
    return (rows ?? []).length > 0;
  }

  // One atomic call (0042_merge_editions.sql). Param names are the SQL's own: keep_id, drop_id, p_actor, p_reason.
  async mergeEditions(keepId: string, dropId: string, actor: string, reason?: string): Promise<MergeSummary> {
    const { data, error } = await this.db.rpc('merge_editions', { keep_id: keepId, drop_id: dropId, p_actor: actor, p_reason: reason ?? null });
    if (error) throw new Error(`mergeEditions (apply 0042_merge_editions.sql): ${error.message}`);
    return (data ?? {}) as MergeSummary;
  }
}

const rowToVenue = (r: any): CanonicalVenue => ({
  id: r.id,
  name: r.name,
  city: r.city ?? undefined,
  region: r.region ?? undefined,
  country: r.country ?? undefined,
  createdAt: r.created_at,
});

const rowToAiCall = (r: any): AiCallRow => ({
  id: r.id,
  createdAt: r.created_at,
  feature: r.feature,
  jobId: r.job_id ?? null,
  eventId: r.event_id ?? null,
  userId: r.user_id ?? null,
  provider: r.provider,
  model: r.model,
  sourceDocumentId: r.source_document_id ?? null,
  inputChars: r.input_chars ?? null,
  inputTokens: r.input_tokens ?? null,
  outputTokens: r.output_tokens ?? null,
  estCostUsd: r.est_cost_usd == null ? null : Number(r.est_cost_usd),
  durationMs: r.duration_ms ?? null,
  outcome: r.outcome,
  errorCode: r.error_code ?? null,
  guardReason: r.guard_reason ?? null,
  namesReturned: r.names_returned ?? null,
  namesVerbatim: r.names_verbatim ?? null,
  namesRejected: r.names_rejected ?? null,
});

const rowToShareLink = (r: any): ShareLink => ({
  id: r.id,
  codeHash: r.code_hash,
  settings: r.settings,
  createdAt: r.created_at,
  revokedAt: r.revoked_at ?? undefined,
  userId: r.user_id ?? undefined,
});

// performer_claims row to PerformerClaim.
const rowToClaim = (r: any): PerformerClaim => ({
  id: r.id,
  jobId: r.job_id,
  documentId: r.document_id,
  sourceType: r.source_type,
  sourceUrl: r.source_url,
  name: r.name,
  quotedSpan: r.quoted_span,
  evidence: r.evidence,
  day: r.day ?? undefined,
  stage: r.stage ?? undefined,
  startTime: r.start_time ?? undefined,
  endTime: r.end_time ?? undefined,
  mbid: r.mbid ?? undefined,
  billing: r.billing ?? undefined,
  extractor: r.extractor,
  extractorVersion: r.extractor_version,
  createdAt: r.created_at,
});
