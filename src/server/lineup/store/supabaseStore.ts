import { SupabaseClient } from '@supabase/supabase-js';
import {
  ArtistIdentity,
  BlocklistEntry,
  Correction,
  Edition,
  EditionPerformance,
  ExtractionExample,
  LookupJob,
  PerformerClaim,
  QuotaUsage,
  SeriesRecord,
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
import { LineupStore, MAX_EXAMPLES_PER_DOMAIN, roundRobin, STALE_RUN_MS, type UserScope } from './types';
import { ArtistEditionRow, Entity, EntityAlias, EntityLink, HistoryEntry } from '../../entities/types';
import { checkLinks } from '../../entities/integrity';
import { SHARE_EVENT_COLUMNS, type ShareLink } from '../../share/types';
import type { CachedResponse } from '../responseCache';

// Postgres-backed store. Tables are defined in
// supabase/migrations/0002_source_first_lineups.sql, 0003_event_log.sql and
// 0004_email_imports.sql (optional: only email import needs it).
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

  private ownerId: Promise<string | null> | null = null;

  // The owner's user id from the members table (0017), read once.
  ownerUserId() {
    this.ownerId ??= (async () => {
      const { data, error } = await this.db.from('members').select('user_id').eq('role', 'owner').maybeSingle();
      return error ? null : ((data as any)?.user_id ?? null);
    })();
    return this.ownerId;
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

  async getSeries(slug: string) {
    const r = this.check(await this.db.from('event_series').select('*').eq('slug', slug).maybeSingle(), 'getSeries');
    if (!r) return null;
    return {
      slug: r.slug,
      name: r.name,
      lineupUrl: r.lineup_url ?? undefined,
      clashfinderSlugs: r.clashfinder_slugs ?? {},
      sourcePriority: r.source_priority ?? undefined,
    } as SeriesRecord;
  }

  async upsertSeries(s: SeriesRecord) {
    this.check(
      await this.db.from('event_series').upsert({
        slug: s.slug,
        name: s.name,
        lineup_url: s.lineupUrl ?? null,
        clashfinder_slugs: s.clashfinderSlugs ?? {},
        source_priority: s.sourcePriority ?? null,
      }),
      'upsertSeries',
    );
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
      b2b: p.b2b?.length ? p.b2b : undefined,
      name: p.name,
      days: p.days ?? [],
      stages: p.stages ?? [],
      status: p.status,
      billing: p.billing ?? undefined,
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
      confidence: p.confidence,
      sources: p.sources,
    };
    if (p.slotId) row.slot_id = p.slotId;
    if (p.alias) row.alias = p.alias;
    if (p.set) row.set = p.set;
    if (p.b2b?.length) row.b2b = p.b2b;
    return row;
  }

  private toEdition(row: any, perfs: any[]): Edition {
    return {
      id: row.id,
      key: row.key,
      seriesSlug: row.series_slug,
      year: row.year,
      name: row.name,
      startDate: row.start_date ?? undefined,
      endDate: row.end_date ?? undefined,
      venue: row.venue ?? undefined,
      city: row.city ?? undefined,
      country: row.country ?? undefined,
      status: row.status,
      confirmedAt: row.confirmed_at ?? undefined,
      updatedAt: row.updated_at,
      factSourceNote: row.fact_source_note ?? undefined,
      performances: perfs.map((p: any) => this.toPerformance(p)),
    };
  }

  // A few requests for many editions: ids go in the URL 100 at a time, and
  // performances come in pages of 1000 (Supabase's row cap per select).
  async getEditions(ids: string[]) {
    const out: Edition[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = this.check(await this.db.from('event_editions').select('*').in('id', chunk), 'getEditions');
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

  async getEditionByKey(key: string) {
    const row = this.check(await this.db.from('event_editions').select('*').eq('key', key).maybeSingle(), 'getEditionByKey');
    return row ? this.loadEdition(row) : null;
  }

  async getEdition(id: string) {
    const row = this.check(await this.db.from('event_editions').select('*').eq('id', id).maybeSingle(), 'getEdition');
    return row ? this.loadEdition(row) : null;
  }

  async upsertEdition(e: Edition) {
    const series = await this.getSeries(e.seriesSlug);
    if (!series) await this.upsertSeries({ slug: e.seriesSlug, name: e.name });
    this.check(
      await this.db.from('event_editions').upsert({
        id: e.id,
        key: e.key,
        series_slug: e.seriesSlug,
        year: e.year,
        name: e.name,
        start_date: e.startDate ?? null,
        end_date: e.endDate ?? null,
        venue: e.venue ?? null,
        city: e.city ?? null,
        country: e.country ?? null,
        status: e.status,
        confirmed_at: e.confirmedAt ?? null,
        fact_source_note: e.factSourceNote ?? null,
        updated_at: e.updatedAt,
      }),
      'upsertEdition',
    );
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
      await this.db.from('event_editions').select('*').order('updated_at', { ascending: false }).limit(limit),
      'listEditions',
    );
    const ids = (rows ?? []).map((r: any) => r.id as string);
    const loaded = new Map((await this.getEditions(ids)).map((e) => [e.id, e]));
    return ids.map((id) => loaded.get(id)).filter((e): e is Edition => Boolean(e));
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
    await this.writeActivity(list.flatMap((e) => diffEvent(before.get(e.id) ?? null, splitEventCity(e), isCiphertext)), now);
  }

  async getEvent(id: string) {
    const r = this.check(await this.mine(this.own('logged_events').select('*').eq('id', id).is('deleted_at', null)).maybeSingle(), 'getEvent');
    return r ? this.rowToEvent(r) : null;
  }

  async listEvents() {
    const rows = this.check(await this.mine(this.own('logged_events').select('*').is('deleted_at', null)), 'listEvents');
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
    this.check(
      await this.db
        .from('canonical_artists')
        .upsert({ key: a.key, name: a.name, mbid: a.mbid ?? null, resolved_at: a.resolvedAt ?? null }),
      'upsertArtist',
    );
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

  async artistPerformances(keys: string[]): Promise<ArtistEditionRow[]> {
    const out: ArtistEditionRow[] = [];
    for (let i = 0; i < keys.length; i += 200) {
      const rows = this.check(
        await this.db.from('performances').select('*').in('artist_key', keys.slice(i, i + 200)),
        'artistPerformances',
      );
      for (const r of (rows ?? []) as any[]) out.push({ editionId: r.edition_id, ...this.toPerformance(r) });
    }
    return out;
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
}

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
