import { SupabaseClient } from '@supabase/supabase-js';
import {
  ArtistIdentity,
  Attendance,
  BlocklistEntry,
  Correction,
  Edition,
  ExtractionExample,
  LookupJob,
  PerformerClaim,
  QuotaUsage,
  SeriesRecord,
  SourceDocument,
  SourceStat,
  SourceType,
} from '../types';
import { LineupStore, MAX_EXAMPLES_PER_DOMAIN } from './types';

// Postgres-backed store. Tables are defined in
// supabase/migrations/0002_source_first_lineups.sql.
export class SupabaseLineupStore implements LineupStore {
  readonly kind = 'supabase' as const;

  constructor(private readonly db: SupabaseClient) {}

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
      log: job.log,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
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
      log: row.log ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createJob(job: LookupJob) {
    this.check(await this.db.from('lookup_jobs').insert(this.jobToRow(job)), 'createJob');
  }

  async getJob(id: string) {
    const data = this.check(await this.db.from('lookup_jobs').select('*').eq('id', id).maybeSingle(), 'getJob');
    return data ? this.rowToJob(data) : null;
  }

  async updateJob(job: LookupJob) {
    this.check(await this.db.from('lookup_jobs').upsert(this.jobToRow(job)), 'updateJob');
  }

  async listJobs(limit: number) {
    const data = this.check(
      await this.db.from('lookup_jobs').select('*').order('created_at', { ascending: false }).limit(limit),
      'listJobs',
    );
    return (data ?? []).map((r) => this.rowToJob(r));
  }

  async dueJobs(now: Date, limit: number) {
    const iso = now.toISOString();
    const data = this.check(
      await this.db
        .from('lookup_jobs')
        .select('*')
        .in('status', ['queued', 'waiting_quota'])
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${iso}`)
        .order('created_at', { ascending: true })
        .limit(limit),
      'dueJobs',
    );
    return (data ?? []).map((r) => this.rowToJob(r));
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
    return (data ?? []).map(
      (r: any): PerformerClaim => ({
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
        extractor: r.extractor,
        extractorVersion: r.extractor_version,
        createdAt: r.created_at,
      }),
    );
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
      performances: (perfs ?? []).map((p: any) => ({
        artistKey: p.artist_key,
        name: p.name,
        days: p.days ?? [],
        stages: p.stages ?? [],
        status: p.status,
        confidence: Number(p.confidence),
        sources: p.sources ?? [],
      })),
    };
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
        updated_at: e.updatedAt,
      }),
      'upsertEdition',
    );
    for (const p of e.performances) {
      if (!(await this.getArtist(p.artistKey))) await this.upsertArtist({ key: p.artistKey, name: p.name });
    }
    this.check(await this.db.from('performances').delete().eq('edition_id', e.id), 'upsertEdition clear');
    if (e.performances.length > 0) {
      this.check(
        await this.db.from('performances').insert(
          e.performances.map((p) => ({
            edition_id: e.id,
            artist_key: p.artistKey,
            name: p.name,
            days: p.days,
            stages: p.stages,
            status: p.status,
            confidence: p.confidence,
            sources: p.sources,
          })),
        ),
        'upsertEdition performances',
      );
    }
  }

  async listEditions(limit: number) {
    const rows = this.check(
      await this.db.from('event_editions').select('*').order('updated_at', { ascending: false }).limit(limit),
      'listEditions',
    );
    return Promise.all((rows ?? []).map((r) => this.loadEdition(r)));
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

  async putAlias(normalizedAlias: string, canonicalName: string) {
    this.check(
      await this.db.from('artist_aliases').upsert({ alias_normalized: normalizedAlias, canonical_name: canonicalName }),
      'putAlias',
    );
  }

  async getBlocklist(domains: string[]) {
    const rows = this.check(await this.db.from('extraction_blocklist').select('*').in('domain', domains), 'getBlocklist');
    return (rows ?? []).map((r: any): BlocklistEntry => ({ domain: r.domain, normalized: r.normalized, rejections: r.rejections }));
  }

  async bumpBlocklist(domain: string, normalized: string) {
    const existing = this.check(
      await this.db.from('extraction_blocklist').select('*').eq('domain', domain).eq('normalized', normalized).maybeSingle(),
      'bumpBlocklist lookup',
    );
    this.check(
      await this.db
        .from('extraction_blocklist')
        .upsert({ domain, normalized, rejections: (existing?.rejections ?? 0) + 1 }),
      'bumpBlocklist',
    );
  }

  async getSourceStats() {
    const rows = this.check(await this.db.from('source_stats').select('*'), 'getSourceStats');
    return (rows ?? []).map(
      (r: any): SourceStat => ({ sourceType: r.source_type, scope: r.scope, accepted: r.accepted, rejected: r.rejected }),
    );
  }

  async bumpSourceStat(sourceType: SourceType, scope: string, accepted: boolean) {
    const r = this.check(
      await this.db.from('source_stats').select('*').eq('source_type', sourceType).eq('scope', scope).maybeSingle(),
      'bumpSourceStat lookup',
    );
    this.check(
      await this.db.from('source_stats').upsert({
        source_type: sourceType,
        scope,
        accepted: (r?.accepted ?? 0) + (accepted ? 1 : 0),
        rejected: (r?.rejected ?? 0) + (accepted ? 0 : 1),
      }),
      'bumpSourceStat',
    );
  }

  async addCorrection(c: Correction) {
    this.check(
      await this.db.from('corrections').insert({
        id: c.id,
        edition_key: c.editionKey,
        kind: c.kind,
        original: c.original ?? null,
        corrected: c.corrected ?? null,
        source_types: c.sourceTypes,
        source_urls: c.sourceUrls,
        created_at: c.createdAt,
      }),
      'addCorrection',
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

  async addAttendance(a: Attendance) {
    this.check(
      await this.db.from('attendance').insert({
        id: a.id,
        edition_id: a.editionId,
        days_attended: a.daysAttended,
        rating: a.rating ?? null,
        ticket_price: a.ticketPrice ?? null,
        companions: a.companions ?? [],
        notes: a.notes ?? null,
        created_at: a.createdAt,
      }),
      'addAttendance',
    );
    if (a.seenArtistKeys.length > 0) {
      this.check(
        await this.db
          .from('seen_sets')
          .insert(a.seenArtistKeys.map((k) => ({ attendance_id: a.id, artist_key: k }))),
        'addAttendance seen_sets',
      );
    }
  }

  async listAttendance() {
    const rows = this.check(await this.db.from('attendance').select('*, seen_sets(artist_key)'), 'listAttendance');
    return (rows ?? []).map(
      (r: any): Attendance => ({
        id: r.id,
        editionId: r.edition_id,
        daysAttended: r.days_attended ?? [],
        seenArtistKeys: (r.seen_sets ?? []).map((s: any) => s.artist_key),
        rating: r.rating ?? undefined,
        ticketPrice: r.ticket_price ?? undefined,
        companions: r.companions ?? [],
        notes: r.notes ?? undefined,
        createdAt: r.created_at,
      }),
    );
  }

  async getArtist(key: string) {
    const r = this.check(await this.db.from('canonical_artists').select('*').eq('key', key).maybeSingle(), 'getArtist');
    return r ? { key: r.key, name: r.name, mbid: r.mbid ?? undefined, resolvedAt: r.resolved_at ?? undefined } : null;
  }

  async upsertArtist(a: ArtistIdentity) {
    this.check(
      await this.db
        .from('canonical_artists')
        .upsert({ key: a.key, name: a.name, mbid: a.mbid ?? null, resolved_at: a.resolvedAt ?? null }),
      'upsertArtist',
    );
  }

  async listUnresolvedArtists(limit: number) {
    const rows = this.check(
      await this.db.from('canonical_artists').select('*').is('resolved_at', null).limit(limit),
      'listUnresolvedArtists',
    );
    return (rows ?? []).map((r: any): ArtistIdentity => ({ key: r.key, name: r.name, mbid: r.mbid ?? undefined }));
  }
}
