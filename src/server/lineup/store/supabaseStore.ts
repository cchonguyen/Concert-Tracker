import { SupabaseClient } from '@supabase/supabase-js';
import {
  ArtistIdentity,
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
import { LoggedEvent } from '../../events/types';
import { LineupFacts, lineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';
import { LineupStore, MAX_EXAMPLES_PER_DOMAIN, STALE_RUN_MS } from './types';

// Postgres-backed store. Tables are defined in
// supabase/migrations/0002_source_first_lineups.sql, 0003_event_log.sql and
// 0004_email_imports.sql (optional: only email import needs it).
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
      event_id: job.eventId ?? null,
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
      eventId: row.event_id ?? undefined,
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

  async getJobs(ids: string[]) {
    if (!ids.length) return [];
    const data = this.check(await this.db.from('lookup_jobs').select('*').in('id', ids), 'getJobs');
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
      performances: perfs.map((p: any) => ({
        artistKey: p.artist_key,
        name: p.name,
        days: p.days ?? [],
        stages: p.stages ?? [],
        status: p.status,
        billing: p.billing ?? undefined,
        confidence: Number(p.confidence),
        sources: p.sources ?? [],
      })),
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
        updated_at: e.updatedAt,
      }),
      'upsertEdition',
    );
    await this.ensureArtists(e.performances.map((p) => ({ key: p.artistKey, name: p.name })));
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
            billing: p.billing ?? null,
            confidence: p.confidence,
            sources: p.sources,
          })),
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

  async putAliases(aliases: Record<string, string>) {
    const rows = Object.entries(aliases).map(([alias, name]) => ({ alias_normalized: alias, canonical_name: name }));
    if (rows.length) this.check(await this.db.from('artist_aliases').upsert(rows), 'putAliases');
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

  private eventToRow(e: LoggedEvent) {
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
      weather: e.weather ?? null,
      days_attended: e.daysAttended,
      companions: e.companions,
      rating: e.rating ?? null,
      ticket_price: e.ticketPrice ?? null,
      notes: e.notes ?? null,
      created_at: e.createdAt,
      updated_at: e.updatedAt,
    };
  }

  private rowToEvent(r: any): LoggedEvent {
    return {
      id: r.id,
      input: r.input ?? '',
      name: r.name,
      year: r.year ?? undefined,
      month: r.month ?? undefined,
      startDate: r.start_date ?? undefined,
      endDate: r.end_date ?? undefined,
      venue: r.venue ?? undefined,
      city: r.city ?? undefined,
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
      weather: r.weather ?? undefined,
      daysAttended: r.days_attended ?? [],
      companions: r.companions ?? [],
      rating: r.rating ?? undefined,
      ticketPrice: r.ticket_price ?? undefined,
      notes: r.notes ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async putEvent(e: LoggedEvent) {
    this.check(await this.db.from('logged_events').upsert(this.eventToRow(e)), 'putEvent');
  }

  async putEvents(list: LoggedEvent[]) {
    if (list.length) this.check(await this.db.from('logged_events').upsert(list.map((e) => this.eventToRow(e))), 'putEvents');
  }

  async getEvent(id: string) {
    const r = this.check(await this.db.from('logged_events').select('*').eq('id', id).maybeSingle(), 'getEvent');
    return r ? this.rowToEvent(r) : null;
  }

  async listEvents() {
    const rows = this.check(await this.db.from('logged_events').select('*'), 'listEvents');
    return (rows ?? []).map((r: any) => this.rowToEvent(r));
  }

  async deleteEvent(id: string) {
    this.check(await this.db.from('logged_events').delete().eq('id', id), 'deleteEvent');
  }

  // email_imports (0004) is optional: the app starts without it and only
  // email import asks for the migration.
  async listImports() {
    const rows = this.check(await this.db.from('email_imports').select('data'), 'listImports (apply 0004_email_imports.sql)');
    return (rows ?? []).map((r: any) => r.data as EmailImport);
  }

  async putImports(rows: EmailImport[]) {
    if (!rows.length) return;
    this.check(
      await this.db.from('email_imports').upsert(
        rows.map((r) => ({ id: r.id, key: r.key, status: r.status, start_date: r.startDate ?? null, data: r, updated_at: r.updatedAt })),
      ),
      'putImports (apply 0004_email_imports.sql)',
    );
  }

  // app_settings (0006) is optional too: only "Check email" needs it.
  async getSetting<T>(key: string) {
    const row = this.check(
      await this.db.from('app_settings').select('data').eq('key', key).maybeSingle(),
      'getSetting (apply 0006_app_settings.sql)',
    );
    return row ? ((row as any).data as T) : null;
  }

  async putSetting<T>(key: string, data: T) {
    this.check(
      await this.db.from('app_settings').upsert({ key, data, updated_at: new Date().toISOString() }),
      'putSetting (apply 0006_app_settings.sql)',
    );
  }

  async getArtist(key: string) {
    const r = this.check(await this.db.from('canonical_artists').select('*').eq('key', key).maybeSingle(), 'getArtist');
    return r ? { key: r.key, name: r.name, mbid: r.mbid ?? undefined, resolvedAt: r.resolved_at ?? undefined } : null;
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

  async listUnresolvedArtists(limit: number) {
    const rows = this.check(
      await this.db.from('canonical_artists').select('*').is('resolved_at', null).limit(limit),
      'listUnresolvedArtists',
    );
    return (rows ?? []).map((r: any): ArtistIdentity => ({ key: r.key, name: r.name, mbid: r.mbid ?? undefined }));
  }
}

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
