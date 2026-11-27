import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
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
import { splitEventCity } from '../../events/regions';
import { LineupFacts, lineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';
import type { ArtistGenres, GenreChange } from '../../events/genres';
import type { GenreVocabChange, GenreVocabulary, VocabGenre } from '../../events/genreTypes';
import { diffEvent, type ActivityDraft, type ActivityEntry } from '../../events/activityLog';
import { isCiphertext } from '../../auth/vault';
import { ArtistAliasRow, ArtistEditionRow, CANONICAL_OPERATIONS, Entity, EntityAlias, EntityLink, HistoryEntry } from '../../entities/types';
import type {
  SqlActivityRow,
  SqlArtistImage,
  SqlCanonicalEntry,
  SqlEntityImage,
  SqlEventSeenImage,
  SqlOwnerAliasImage,
  SqlOwnerLinkImage,
  SqlPerformanceImage,
} from '../../entities/canonicalManage';
import { checkAliases, checkEntities, checkEventRefs, checkLinks } from '../../entities/integrity';
import type { ShareLink } from '../../share/types';
import { shareEventOnly } from '../../share/types';
import type { AiCallRow, GenreChangeQuery, GenreVocabChangeQuery, GenreVocabWriteMeta, GenreVocabWriteRow, GenreWriteMeta, GenreWriteRow, IngestTraceRow, MergeSummary } from './types';
import type { CanonicalVenue, EditionChange, EditionInference, InferenceStatus, InferenceVote, NewEditionInference, ReviewQueueItem, ReviewQueueKind, VenueAlias, EditionExternalId } from '../types';
import { ArtistIdTakenError, assertNoPersonalFields, EditionOccurrenceConflictError, ExternalIdConflictError, venueIdFor } from './types';
import { normalizeName } from '../normalizeName';
import type { CachedResponse } from '../responseCache';
import type { ArtistCleanupReport, ArtistCleanupRow } from '../../entities/artistCleanupCsv';
import { emptyStatusCounts } from '../../entities/artistCleanupCsv';
import {
  canonicalEditionPage,
  editionMatchesStatusFilter,
  isVerifiedStatus,
  suggestEditionMatches,
  CanonicalApplyResult,
  CanonicalHistoryEntry,
  CanonicalHistoryPage,
  CanonicalHistoryPageOptions,
  CanonicalStoreError,
  CanonicalUndoResult,
  decodeCanonicalHistoryCursor,
  encodeCanonicalHistoryCursor,
  isCanonicalOperation,
  isOlderThanCursor,
  isStaleRun,
  LineupStore,
  MAX_EXAMPLES_PER_DOMAIN,
  normalizeCanonicalHistoryLimit,
  roundRobin,
  STALE_RUN_MS,
  type CanonicalEditionPageOptions,
  type CanonicalEditionStatusFilter,
  type SuggestEditionOptions,
  type UserScope,
} from './types';

type DocumentMeta = Omit<SourceDocument, 'body'>;

interface FileState {
  jobs: Record<string, LookupJob>;
  documents: Record<string, DocumentMeta>;
  claims: PerformerClaim[];
  series: Record<string, SeriesRecord>;
  editions: Record<string, Edition>;
  quota: Record<string, QuotaUsage>;
  aliases: Record<string, string>;
  blocklist: BlocklistEntry[];
  sourceStats: SourceStat[];
  corrections: Correction[];
  examples: ExtractionExample[];
  events: Record<string, LoggedEvent>;
  imports: Record<string, EmailImport>;
  settings?: Record<string, unknown>;
  artists: Record<string, ArtistIdentity>;
  artistGenres?: Record<string, ArtistGenres>; // by `${source}|${key}`
  genreChanges?: GenreChange[]; // artist_genre_changes: append-only, only undoneAt is ever set
  genreVocab?: Record<string, VocabGenre>; // genres with their aliases and umbrellas (0060), by key
  genreVocabChanges?: GenreVocabChange[]; // genre_changes: append-only, only undoneAt is ever set
  entities?: Record<string, Entity>;
  entityAliases?: EntityAlias[];
  entityLinks?: EntityLink[];
  entityHistory?: Record<string, HistoryEntry>;
  activity?: Array<ActivityEntry & { userId: string | null }>; // the Log; kept one year
  userGenres?: Record<string, Record<string, ArtistGenres>>; // a member's own genres, by act key
  userEntities?: Record<string, Pick<FileState, 'entities' | 'entityAliases' | 'entityLinks' | 'entityHistory'>>;
  shareLinks?: Record<string, ShareLink>;
  // Multi-user: who owns each personal row (`<table>:<id>` to user id); a row
  // with no entry is the owner's, as in Supabase where user_id defaults to
  // the owner. Settings per member.
  responseCache?: Record<string, CachedResponse>;
  aiCalls?: AiCallRow[];
  ingestTraces?: IngestTraceRow[];
  venues?: Record<string, CanonicalVenue>;
  venueAliases?: Array<VenueAlias>;
  editionExternalIds?: EditionExternalId[];
  editionChanges?: EditionChange[];
  editionInferences?: EditionInference[];
  inferenceVotes?: InferenceVote[];
  reviewQueue?: ReviewQueueItem[];
  owners?: Record<string, string>;
  userSettings?: Record<string, Record<string, unknown>>;
  // Canonical artist changes applied through applyCanonicalArtistChange, by history ID: the plan entry
  // (the SQL manifest) kept for Undo, and when it was undone.
  canonicalChanges?: Record<string, { entry: SqlCanonicalEntry; undoneAt?: string }>;
}

function emptyState(): FileState {
  return {
    jobs: {},
    documents: {},
    claims: [],
    series: {},
    editions: {},
    quota: {},
    aliases: {},
    blocklist: [],
    sourceStats: [],
    corrections: [],
    examples: [],
    events: {},
    imports: {},
    artists: {},
  };
}

const clone = <T>(v: T): T => structuredClone(v);

// JSON-file store for local development. Document bodies live in separate
// files so the main state file stays small.
export class FileLineupStore implements LineupStore {
  readonly kind = 'file' as const;
  private state: FileState | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  // Canonical apply and Undo run one after another on this instance (see serializeCanonical).
  private canonicalChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  forUser(scope: UserScope): LineupStore {
    return scopedFileStore(this, scope);
  }

  // For scopedFileStore only.
  async ownersState(): Promise<{ owners: Record<string, string>; userSettings: Record<string, Record<string, unknown>> }> {
    const state = await this.load();
    state.owners ??= {};
    state.userSettings ??= {};
    return { owners: state.owners, userSettings: state.userSettings };
  }

  async saveOwners(): Promise<void> {
    await this.save();
  }

  private get statePath(): string {
    return path.join(this.dir, 'lineup-store.json');
  }

  private docPath(id: string): string {
    return path.join(this.dir, 'documents', `${id}.txt`);
  }

  private async load(): Promise<FileState> {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      this.state = { ...emptyState(), ...JSON.parse(raw) };
    } catch {
      this.state = emptyState();
    }
    return this.state!;
  }

  private async save(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, this.statePath);
    });
    return this.writeChain;
  }

  async createJob(job: LookupJob) {
    (await this.load()).jobs[job.id] = clone(job);
    await this.save();
  }

  async getJob(id: string) {
    const job = (await this.load()).jobs[id];
    return job ? clone(job) : null;
  }

  async updateJob(job: LookupJob) {
    (await this.load()).jobs[job.id] = clone(job);
    await this.save();
  }

  async listJobs(limit: number) {
    const jobs = Object.values((await this.load()).jobs);
    return clone(jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  async listCanonicalJobs(limit: number) {
    const jobs = Object.values((await this.load()).jobs).filter((j) => j.kind === 'lineup' && !j.eventId);
    return clone(jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  async getJobs(ids: string[]) {
    const jobs = (await this.load()).jobs;
    return clone(ids.map((id) => jobs[id]).filter(Boolean));
  }

  async dueJobs(now: Date, limit: number) {
    const iso = now.toISOString();
    const jobs = Object.values((await this.load()).jobs).filter(
      (j) =>
        ((j.status === 'queued' || j.status === 'waiting_quota') && (!j.nextAttemptAt || j.nextAttemptAt <= iso)) ||
        isStaleRun(j, now),
    );
    return clone(roundRobin(jobs, limit));
  }

  async putDocument(doc: SourceDocument) {
    const state = await this.load();
    const existing = Object.values(state.documents).find(
      (d) => d.url === doc.url && d.contentHash === doc.contentHash,
    );
    if (existing) return { ...existing, body: doc.body };
    const { body, ...meta } = doc;
    await fs.mkdir(path.dirname(this.docPath(doc.id)), { recursive: true });
    await fs.writeFile(this.docPath(doc.id), body);
    state.documents[doc.id] = meta;
    await this.save();
    return clone(doc);
  }

  async getDocument(id: string) {
    const meta = (await this.load()).documents[id];
    if (!meta) return null;
    const body = await fs.readFile(this.docPath(id), 'utf8').catch(() => '');
    return { ...clone(meta), body };
  }

  async addPerformerClaims(claims: PerformerClaim[]) {
    (await this.load()).claims.push(...clone(claims));
    await this.save();
  }

  async listPerformerClaims(jobId: string) {
    return clone((await this.load()).claims.filter((c) => c.jobId === jobId));
  }

  async findExtractedClaims(q: { editionKey: string; documentId: string; extractor: string; extractorVersion: string; excludeJobId: string }) {
    const state = await this.load();
    const jobIds = new Set(
      Object.values(state.jobs)
        .filter((j) => j.editionKey === q.editionKey && j.id !== q.excludeJobId)
        .map((j) => j.id),
    );
    const claims = state.claims.filter(
      (c) =>
        jobIds.has(c.jobId) && c.documentId === q.documentId && c.extractor === q.extractor && c.extractorVersion === q.extractorVersion,
    );
    // One earlier job's claims, so two cached runs are not added together.
    const first = claims[0]?.jobId;
    return clone(claims.filter((c) => c.jobId === first));
  }

  private normalizeSeriesRecord(s: SeriesRecord): SeriesRecord {
    // No type stays empty: a series is never typed festival by default (series type fix).
    const out: SeriesRecord = clone(s);
    if (s.kind === 'tour' || s.kind === 'festival') out.kind = s.kind;
    else delete out.kind;
    if (out.kind === 'tour') {
      delete out.city;
      delete out.region;
      delete out.country;
    }
    return out;
  }

  private enrichEdition(state: FileState, ed: Edition): Edition {
    const out = clone(ed);
    if (out.seriesSlug) {
      const rawSeries = state.series[out.seriesSlug];
      if (rawSeries) {
        const s = this.normalizeSeriesRecord(rawSeries);
        out.seriesName = s.name;
        if (s.brand !== undefined) out.seriesBrand = s.brand;
        else delete out.seriesBrand;
        if (s.aliases?.length) out.seriesAliases = clone(s.aliases);
        else delete out.seriesAliases;
        out.seriesKind = s.kind;
        if (s.kind !== 'tour') {
          if (s.city !== undefined) out.seriesCity = s.city;
          else delete out.seriesCity;
          if (s.region !== undefined) out.seriesRegion = s.region;
          else delete out.seriesRegion;
          if (s.country !== undefined) out.seriesCountry = s.country;
          else delete out.seriesCountry;
        } else {
          delete out.seriesCity;
          delete out.seriesRegion;
          delete out.seriesCountry;
        }
      }
    }
    return out;
  }

  private toEditionHeader(state: FileState, ed: Edition): EditionHeader {
    const { performances: _perfs, ...header } = this.enrichEdition(state, ed);
    return header;
  }

  async getSeries(slug: string) {
    const s = (await this.load()).series[slug];
    return s ? this.normalizeSeriesRecord(s) : null;
  }

  async upsertSeries(series: SeriesRecord) {
    (await this.load()).series[series.slug] = this.normalizeSeriesRecord(series);
    await this.save();
  }

  async listSeries(opts: { query?: string; brand?: string; limit?: number } = {}): Promise<SeriesSummary[]> {
    const state = await this.load();
    const counts = new Map<string, number>();
    for (const ed of Object.values(state.editions)) {
      if (ed.seriesSlug) counts.set(ed.seriesSlug, (counts.get(ed.seriesSlug) ?? 0) + 1);
    }
    const q = (opts.query ?? '').trim().toLowerCase();
    const b = (opts.brand ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    return clone(
      Object.values(state.series)
        .map((s) => this.normalizeSeriesRecord(s))
        .filter((s) => {
          if (b && (s.brand ?? '').trim().toLowerCase() !== b) return false;
          if (!q) return true;
          return [s.slug, s.name, s.brand ?? '', ...(s.aliases ?? [])].some((v) => v.toLowerCase().includes(q));
        })
        .sort((a, z) => (a.brand ?? a.name).localeCompare(z.brand ?? z.name) || a.name.localeCompare(z.name))
        .slice(0, limit)
        .map((s) => ({ ...s, editionCount: counts.get(s.slug) ?? 0 })),
    );
  }

  async mergeSeries(keepSlug: string, dropSlug: string): Promise<MergeSummary> {
    if (!keepSlug?.trim() || !dropSlug?.trim()) throw new Error('merge_canonical_series: both slugs are required');
    if (keepSlug === dropSlug) throw new Error('merge_canonical_series: keep and drop slugs are the same');
    const state = await this.load();
    const keepRaw = state.series[keepSlug];
    const dropRaw = state.series[dropSlug];
    if (!keepRaw) throw new Error(`merge_canonical_series: series ${keepSlug} not found`);
    if (!dropRaw) throw new Error(`merge_canonical_series: series ${dropSlug} not found`);
    const keep = this.normalizeSeriesRecord(keepRaw);
    const drop = this.normalizeSeriesRecord(dropRaw);

    const seen = new Set<string>();
    const aliases: string[] = [];
    const rawAliases = [
      ...(keep.aliases ?? []),
      ...(drop.aliases ?? []),
      ...(drop.name.trim().toLowerCase() !== keep.name.trim().toLowerCase() ? [drop.name] : []),
    ];
    for (const raw of rawAliases) {
      const val = raw.trim();
      if (!val) continue;
      const key = val.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(val);
    }

    const kind: SeriesKind = keepRaw.kind === 'tour' || keepRaw.kind === 'festival' ? keepRaw.kind : drop.kind ?? 'festival';
    const isTour = kind === 'tour';
    const brand = keep.brand?.trim() ? keep.brand : drop.brand?.trim() ? drop.brand : undefined;
    const city = isTour ? undefined : (keep.city?.trim() ? keep.city : drop.city?.trim() ? drop.city : undefined);
    const region = isTour ? undefined : (keep.region?.trim() ? keep.region : drop.region?.trim() ? drop.region : undefined);
    const country = isTour ? undefined : (keep.country?.trim() ? keep.country : drop.country?.trim() ? drop.country : undefined);
    const lineupUrl = keep.lineupUrl?.trim() ? keep.lineupUrl : drop.lineupUrl?.trim() ? drop.lineupUrl : undefined;
    const sourcePriority = keep.sourcePriority?.length ? keep.sourcePriority : drop.sourcePriority;
    const clashfinderSlugs = { ...(drop.clashfinderSlugs ?? {}), ...(keep.clashfinderSlugs ?? {}) };

    state.series[keepSlug] = {
      slug: keep.slug,
      name: keep.name,
      kind,
      ...(brand !== undefined ? { brand } : {}),
      // The kept series' qualifier stays, as merge_canonical_series leaves that column alone (0058).
      ...(keep.qualifier?.trim() ? { qualifier: keep.qualifier } : {}),
      ...(city !== undefined ? { city } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(country !== undefined ? { country } : {}),
      aliases,
      ...(lineupUrl !== undefined ? { lineupUrl } : {}),
      ...(sourcePriority?.length ? { sourcePriority } : {}),
      clashfinderSlugs,
    };

    let editionsMoved = 0;
    for (const ed of Object.values(state.editions)) {
      if (ed.seriesSlug === dropSlug) {
        ed.seriesSlug = keepSlug;
        editionsMoved++;
      }
    }
    delete state.series[dropSlug];
    await this.save();
    return { keep_slug: keepSlug, drop_slug: dropSlug, editions_moved: editionsMoved, aliases_count: aliases.length };
  }

  async getEditionByKey(key: string) {
    const state = await this.load();
    const ed = Object.values(state.editions).find((e) => e.key === key);
    return ed ? this.enrichEdition(state, ed) : null;
  }

  async getEdition(id: string) {
    const state = await this.load();
    const ed = state.editions[id];
    return ed ? this.enrichEdition(state, ed) : null;
  }

  async getEditions(ids: string[]) {
    const state = await this.load();
    return ids.map((id) => state.editions[id]).filter((e): e is Edition => Boolean(e)).map((e) => this.enrichEdition(state, e));
  }

  async getEditionHeaders(ids: string[]): Promise<EditionHeader[]> {
    const state = await this.load();
    return ids.map((id) => state.editions[id]).filter((e): e is Edition => Boolean(e)).map((e) => this.toEditionHeader(state, e));
  }

  async findEditionByOccurrence(startDate: string, venueId: string, subjectKey: string): Promise<Edition | null> {
    const state = await this.load();
    const ed = Object.values(state.editions).find(
      (e) => e.startDate === startDate && e.venueId === venueId && e.subjectKey === subjectKey,
    );
    return ed ? this.enrichEdition(state, ed) : null;
  }

  async upsertEdition(edition: Edition) {
    const state = await this.load();
    if (edition.startDate && edition.venueId && edition.subjectKey) {
      const clash = Object.values(state.editions).find(
        (e) =>
          e.id !== edition.id &&
          e.startDate === edition.startDate &&
          e.venueId === edition.venueId &&
          e.subjectKey === edition.subjectKey,
      );
      if (clash) {
        throw new EditionOccurrenceConflictError(
          edition.id,
          edition.startDate,
          edition.venueId,
          edition.subjectKey,
          { id: clash.id, key: clash.key, name: clash.name },
        );
      }
    }
    // Same rule as the Supabase store: undefined keeps the stored weather, null clears it.
    const weather = edition.weather === undefined ? state.editions[edition.id]?.weather : edition.weather ?? undefined;
    const hasLineup = edition.performances.length > 0 ? true : edition.hasLineup;
    state.editions[edition.id] = clone({ ...edition, ...(hasLineup !== undefined ? { hasLineup } : {}), weather });
    await this.save();
  }

  async editionLineupFacts(ids: string[]) {
    const editions = (await this.load()).editions;
    const out: Record<string, LineupFacts> = {};
    for (const id of ids) out[id] = lineupFacts(editions[id] ?? { performances: [] });
    return out;
  }

  async listEditions(limit: number) {
    const state = await this.load();
    const eds = Object.values(state.editions);
    return eds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((e) => this.enrichEdition(state, e));
  }

  async listEditionHeaders(
    opts?: number | { limit?: number; startDate?: string; seriesSlug?: string; year?: number; status?: CanonicalEditionStatusFilter },
  ): Promise<EditionHeader[]> {
    const state = await this.load();
    const normalized = typeof opts === 'number' ? { limit: opts } : (opts ?? {});
    const limit = Math.max(0, Math.floor(normalized.limit ?? 500));
    return Object.values(state.editions)
      .filter((e) => !normalized.startDate || e.startDate === normalized.startDate)
      .filter((e) => !normalized.seriesSlug || e.seriesSlug === normalized.seriesSlug)
      .filter((e) => normalized.year === undefined || e.year === normalized.year)
      .filter((e) => !normalized.status || editionMatchesStatusFilter(e.status, normalized.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((e) => this.toEditionHeader(state, e));
  }

  async listEditionArtistRefs(opts: { editionIds?: string[]; verifiedOnly?: boolean } = {}): Promise<EditionArtistRef[]> {
    const state = await this.load();
    const idSet = opts.editionIds ? new Set(opts.editionIds) : null;
    if (idSet && idSet.size === 0) return [];
    const out: EditionArtistRef[] = [];
    for (const e of Object.values(state.editions)) {
      if (idSet && !idSet.has(e.id)) continue;
      if (opts.verifiedOnly && !isVerifiedStatus(e.status)) continue;
      for (const p of e.performances) {
        out.push({ editionId: e.id, artistKey: p.artistKey, name: p.name, status: p.status });
      }
    }
    return out;
  }

  async suggestEditions(query: string, opts: SuggestEditionOptions) {
    const state = await this.load();
    const enriched = Object.values(state.editions).map((e) => this.enrichEdition(state, e));
    return suggestEditionMatches(enriched, query, opts);
  }

  async listCanonicalEditionsPage(options: CanonicalEditionPageOptions) {
    const state = await this.load();
    const eds = Object.values(state.editions).map((e) => this.enrichEdition(state, e));
    return clone(canonicalEditionPage(eds, options));
  }

  async stampUnsetWeekend(editionId: string, weekend: number): Promise<number> {
    if (!editionId?.trim()) throw new Error('stamp_unset_event_weekend: edition_id is required');
    if (!Number.isInteger(weekend) || weekend < 1 || weekend > 9) {
      throw new Error('stamp_unset_event_weekend: weekend must be between 1 and 9');
    }
    const state = await this.load();
    let updated = 0;
    for (const ev of Object.values(state.events)) {
      if (!ev.deletedAt && ev.editionId === editionId && ev.weekend == null) {
        ev.weekend = weekend;
        updated++;
      }
    }
    if (updated > 0) await this.save();
    return updated;
  }

  async getQuota(key: string) {
    const q = (await this.load()).quota[key];
    return q ? clone(q) : null;
  }

  async setQuota(usage: QuotaUsage) {
    (await this.load()).quota[usage.key] = clone(usage);
    await this.save();
  }

  async getAliases() {
    return clone((await this.load()).aliases);
  }

  async putAliases(aliases: Record<string, string>) {
    Object.assign((await this.load()).aliases, aliases);
    await this.save();
  }

  async deleteAlias(alias: string) {
    delete (await this.load()).aliases[alias];
    await this.save();
  }

  async getBlocklist(domains: string[]) {
    return clone((await this.load()).blocklist.filter((b) => domains.includes(b.domain)));
  }

  async bumpBlocklist(entries: Array<{ domain: string; normalized: string }>) {
    const state = await this.load();
    for (const { domain, normalized } of entries) {
      const entry = state.blocklist.find((b) => b.domain === domain && b.normalized === normalized);
      if (entry) entry.rejections += 1;
      else state.blocklist.push({ domain, normalized, rejections: 1 });
    }
    await this.save();
  }

  async getSourceStats() {
    return clone((await this.load()).sourceStats);
  }

  async bumpSourceStats(deltas: SourceStat[]) {
    const state = await this.load();
    for (const d of deltas) {
      let stat = state.sourceStats.find((s) => s.sourceType === d.sourceType && s.scope === d.scope);
      if (!stat) {
        stat = { sourceType: d.sourceType, scope: d.scope, accepted: 0, rejected: 0 };
        state.sourceStats.push(stat);
      }
      stat.accepted += d.accepted;
      stat.rejected += d.rejected;
    }
    await this.save();
  }

  async addCorrections(corrections: Correction[]) {
    (await this.load()).corrections.push(...clone(corrections));
    await this.save();
  }

  async getExamples(domain: string) {
    return clone((await this.load()).examples.filter((e) => e.domain === domain));
  }

  async addExample(example: ExtractionExample) {
    const state = await this.load();
    state.examples.push(clone(example));
    const forDomain = state.examples.filter((e) => e.domain === example.domain);
    if (forDomain.length > MAX_EXAMPLES_PER_DOMAIN) {
      const oldest = forDomain.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      state.examples = state.examples.filter((e) => e !== oldest);
    }
    await this.save();
  }

  async putEvent(event: LoggedEvent) {
    await this.putEvents([event]);
  }

  async putEvents(events: LoggedEvent[]) {
    return this.putEventsFor(undefined, events);
  }

  async putEventsFor(uid: string | undefined, events: LoggedEvent[]) {
    const state = await this.load();
    // The foreign keys Supabase has on venue_id, place_id and series_id,
    // plus the IDs inside companions and seen that it cannot check.
    const entities = new Map(Object.entries(this.holder(state, uid).entities ?? {}));
    for (const e of events) checkEventRefs(entities, e);
    const now = new Date().toISOString();
    for (const e of events) {
      const prior = state.events[e.id];
      const { seriesKind: _seriesKind, ...cleanEvent } = splitEventCity(e);
      // A save never undeletes a show: deletedAt is only changed by delete and restore.
      state.events[e.id] = clone({ ...cleanEvent, deletedAt: prior?.deletedAt });
      this.logActivity(state, uid, diffEvent(prior ? splitEventCity(prior) : null, cleanEvent, isCiphertext), now);
    }
    await this.save();
  }

  async getEvent(id: string) {
    const ev = (await this.load()).events[id];
    return ev && !ev.deletedAt ? clone(splitEventCity(ev)) : null;
  }

  async listEvents() {
    return clone(Object.values((await this.load()).events).filter((e) => !e.deletedAt).map((e) => splitEventCity(e)));
  }

  async listSeenArtistNames(): Promise<string[]> {
    const events = Object.values((await this.load()).events);
    return events
      .filter((e) => !e.deletedAt)
      .flatMap((e) => (e.seen ?? []).map((a) => a?.name).filter((n): n is string => typeof n === 'string' && Boolean(n.trim())).map((n) => n.trim()));
  }

  // Delete moves the show to Recently deleted. Nothing is erased until the nightly purge.
  async deleteEvent(id: string) {
    return this.deleteEventFor(undefined, id);
  }

  async restoreEvent(id: string) {
    return this.restoreEventFor(undefined, id);
  }

  async eraseDeletedEvent(id: string) {
    return this.eraseDeletedEventFor(undefined, id);
  }

  async emptyTrash() {
    return this.emptyTrashFor(undefined);
  }

  async listActivity(limit: number) {
    return this.listActivityFor(undefined, limit);
  }

  async deleteEventFor(uid: string | undefined, id: string) {
    const state = await this.load();
    const ev = state.events[id];
    if (!ev || ev.deletedAt) return;
    const now = new Date().toISOString();
    ev.deletedAt = now;
    this.logActivity(state, uid, [{ eventId: id, action: 'delete', field: null, before: null, after: null, sensitive: false }], now);
    await this.save();
  }

  async restoreEventFor(uid: string | undefined, id: string) {
    const state = await this.load();
    const ev = state.events[id];
    if (!ev?.deletedAt) return false;
    delete ev.deletedAt;
    this.logActivity(state, uid, [{ eventId: id, action: 'restore', field: null, before: null, after: null, sensitive: false }], new Date().toISOString());
    await this.save();
    return true;
  }

  async listDeletedEvents() {
    return clone(Object.values((await this.load()).events).filter((e) => e.deletedAt).map((e) => splitEventCity(e)));
  }

  async eraseDeletedEventFor(_uid: string | undefined, id: string) {
    const state = await this.load();
    if (!state.events[id]?.deletedAt) return false;
    delete state.events[id];
    await this.save();
    return true;
  }

  async emptyTrashFor(_uid: string | undefined) {
    const state = await this.load();
    let removed = 0;
    for (const [id, ev] of Object.entries(state.events)) {
      if (ev.deletedAt) {
        delete state.events[id];
        removed++;
      }
    }
    if (removed) await this.save();
    return removed;
  }

  // Erase Recently deleted shows older than the cutoff. Their Log rows stay until their own purge.
  async purgeDeletedEvents(olderThan: string) {
    const state = await this.load();
    let purged = 0;
    for (const [id, ev] of Object.entries(state.events)) {
      if (ev.deletedAt && ev.deletedAt < olderThan) {
        delete state.events[id];
        purged++;
      }
    }
    if (purged) await this.save();
    return purged;
  }

  // Erase Log rows older than the cutoff. Run by the nightly job, across every member.
  async purgeActivity(olderThan: string) {
    const state = await this.load();
    const rows = state.activity ?? [];
    const kept = rows.filter((r) => r.at >= olderThan);
    if (kept.length === rows.length) return 0;
    state.activity = kept;
    await this.save();
    return rows.length - kept.length;
  }

  async listActivityFor(uid: string | undefined, limit: number) {
    const rows = ((await this.load()).activity ?? []).filter((r) => (uid === undefined ? true : r.userId === uid));
    // Rows written in the same millisecond keep their write order, newest first.
    const newestFirst = rows.map((r, i) => ({ r, i })).sort((a, b) => b.r.at.localeCompare(a.r.at) || b.i - a.i);
    return clone(newestFirst.map((x) => x.r).slice(0, limit));
  }

  private logActivity(state: FileState, uid: string | undefined, drafts: ActivityDraft[], at: string) {
    state.activity ??= [];
    drafts.forEach((d, i) => {
      state.activity!.push({ ...d, id: `${at}-${state.activity!.length}-${i}`, at, userId: uid ?? null });
    });
  }

  async listImports() {
    return clone(Object.values((await this.load()).imports));
  }

  async putImports(rows: EmailImport[]) {
    const state = await this.load();
    for (const row of rows) state.imports[row.id] = clone(row);
    await this.save();
  }

  async getSetting<T>(key: string) {
    const v = (await this.load()).settings?.[key];
    return v === undefined ? null : clone(v as T);
  }

  async putSetting<T>(key: string, data: T) {
    const state = await this.load();
    state.settings = { ...state.settings, [key]: clone(data) };
    await this.save();
  }

  async listPendingResearchUserIds(): Promise<string[]> {
    const state = await this.load();
    const owners = (await this.ownersState()).owners;
    const ids = new Set<string>();
    for (const ev of Object.values(state.events)) {
      if (ev.details.status !== 'pending') continue;
      const uid = owners[`event:${ev.id}`];
      if (uid) ids.add(uid);
    }
    return [...ids];
  }

  async getArtist(key: string) {
    const a = (await this.load()).artists[key];
    return a ? clone(a) : null;
  }

  async getArtists(keys: string[]) {
    const { artists } = await this.load();
    return clone(keys.map((k) => artists[k]).filter((a): a is ArtistIdentity => Boolean(a)));
  }

  async upsertArtist(artist: ArtistIdentity) {
    const state = await this.load();
    // Same rule as the database's unique MusicBrainz ID (canonical_artists_mbid_key).
    if (artist.mbid && Object.values(state.artists).some((a) => a.key !== artist.key && a.mbid === artist.mbid)) {
      throw new ArtistIdTakenError(artist.key, artist.mbid);
    }
    state.artists[artist.key] = clone(artist);
    await this.save();
  }

  async ensureArtists(artists: ArtistIdentity[]) {
    const state = await this.load();
    for (const a of artists) state.artists[a.key] ??= clone(a);
    await this.save();
  }

  async listArtists() {
    return clone(Object.values((await this.load()).artists));
  }

  async deleteArtists(keys: string[]) {
    const state = await this.load();
    for (const k of keys) delete state.artists[k];
    await this.save();
  }

  // Performances live inside their edition here.
  async artistPerformances(keys: string[]) {
    const out: ArtistEditionRow[] = [];
    for (const e of Object.values((await this.load()).editions)) {
      for (const p of e.performances) if (keys.includes(p.artistKey)) out.push(clone({ ...p, editionId: e.id }));
    }
    return out;
  }

  async putArtistPerformances(rows: ArtistEditionRow[]) {
    const state = await this.load();
    for (const { editionId, ...row } of rows) {
      const edition = state.editions[editionId];
      if (!edition) continue;
      const perf = clone(row) as EditionPerformance;
      const at = edition.performances.findIndex((p) => p.artistKey === perf.artistKey);
      if (at >= 0) edition.performances[at] = perf;
      else edition.performances.push(perf);
    }
    await this.save();
  }

  async deleteArtistPerformances(rows: Array<{ editionId: string; artistKey: string }>) {
    const state = await this.load();
    for (const { editionId, artistKey } of rows) {
      const edition = state.editions[editionId];
      if (edition) edition.performances = edition.performances.filter((p) => p.artistKey !== artistKey);
    }
    await this.save();
  }

  // Canonical artist change, migration 0037 in the file store. Same checks as the SQL functions: the current
  // rows must equal the plan's "before" side (apply) or "after" side (Undo), and the fingerprint must match.
  // Every check runs before the first write. Owner only (scopedFileStore refuses other members).
  async canonicalArtistFingerprint(entry: SqlCanonicalEntry): Promise<string> {
    assertCanonicalEntry(entry);
    return fingerprintOf(currentImages(await this.load(), entry));
  }

  async applyCanonicalArtistChange(entry: SqlCanonicalEntry, fingerprint: string): Promise<CanonicalApplyResult> {
    assertCanonicalEntry(entry);
    return this.serializeCanonical(async () => {
      const state = await this.load();
      const current = currentImages(state, entry);
      if (keyOf(current) !== keyOf(planImages(entry, 'before')) || fingerprintOf(current) !== fingerprint) {
        throw new CanonicalStoreError('stale', 'Preview is out of date; review it again');
      }
      if (lookup(state.canonicalChanges, entry.id)) throw new CanonicalStoreError('generic', 'That change is already recorded.');
      const c = entry.canonical;
      await this.mutateCanonical(state, () => {
        checkWritable(state, c, 'after');
        writeSide(state, c, 'before', 'after', entry.createdAt);
        pushActivity(state, c.activity, entry.createdAt);
        state.canonicalChanges = { ...state.canonicalChanges, [entry.id]: { entry: clone(entry) } };
      });
      return { id: entry.id, operation: entry.operation };
    });
  }

  async undoCanonicalArtistChange(historyId: string): Promise<CanonicalUndoResult> {
    return this.serializeCanonical(async () => {
      const state = await this.load();
      const stored = lookup(state.canonicalChanges, historyId);
      if (!stored) throw new CanonicalStoreError('generic', 'No such change.');
      if (stored.undoneAt) throw new CanonicalStoreError('stale', 'That change was already undone.');
      const entry = stored.entry;
      const c = entry.canonical;
      if (keyOf(currentImages(state, entry)) !== keyOf(planImages(entry, 'after'))) {
        throw new CanonicalStoreError('stale', 'Those records changed after this. Undo the later change first.');
      }
      const now = new Date().toISOString();
      await this.mutateCanonical(state, () => {
        checkWritable(state, c, 'before');
        writeSide(state, c, 'after', 'before', now);
        pushActivity(state, undoActivity(c), now);
        stored.undoneAt = now;
      });
      return { id: historyId, undone: true };
    });
  }

  // One canonical call at a time per store instance: each waits for the one before it to finish.
  private serializeCanonical<T>(run: () => Promise<T>): Promise<T> {
    const next = this.canonicalChain.then(run);
    this.canonicalChain = next.catch(() => undefined);
    return next;
  }

  // Runs the writes on the in-memory state and saves once. If anything throws, the state from before the call is put back.
  private async mutateCanonical(state: FileState, run: () => void): Promise<void> {
    const snapshot = clone(state);
    try {
      run();
      await this.save();
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }

  // The file store is the single-user dev store: no cross-member counts.
  async communityCounts(): Promise<Map<string, number> | null> {
    return null;
  }

  async listUnresolvedArtists(limit: number) {
    return clone(
      Object.values((await this.load()).artists)
        .filter((a) => !a.resolvedAt)
        .slice(0, limit),
    );
  }

  // A member's own genres (user_artist_genres): only ones they set themselves.
  async memberGenres(uid: string): Promise<Record<string, ArtistGenres>> {
    const state = await this.load();
    state.userGenres ??= {};
    return (state.userGenres[uid] ??= {});
  }

  async saveMemberGenres(): Promise<void> {
    await this.save();
  }

  async listArtistGenres() {
    return clone(Object.values((await this.load()).artistGenres ?? {}));
  }

  async putArtistGenres(rows: ArtistGenres[]) {
    const state = await this.load();
    state.artistGenres ??= {};
    for (const r of rows) state.artistGenres[`${r.source}|${r.key}`] = clone(r);
    await this.save();
  }

  async deleteArtistGenres(key: string, source: ArtistGenres['source']) {
    const state = await this.load();
    if (state.artistGenres) delete state.artistGenres[`${source}|${key}`];
    await this.save();
  }

  // artist_genres_write (0059): upsert or delete each row and log it, all or nothing.
  async writeArtistGenres(rows: GenreWriteRow[], meta: GenreWriteMeta): Promise<GenreChange[]> {
    const state = await this.load();
    const changes: GenreChange[] = [];
    await this.mutateCanonical(state, () => {
      state.artistGenres ??= {};
      state.genreChanges ??= [];
      for (const r of rows) {
        const id = `${r.source}|${r.key}`;
        const before = lookup(state.artistGenres, id) ?? null;
        const after = r.row ? { ...clone(r.row), key: r.key, source: r.source } : null;
        if (after) state.artistGenres[id] = after;
        else delete state.artistGenres[id];
        const bare = (g: ArtistGenres | null) => (g ? stableJson({ ...g, checkedAt: null }) : null);
        if (bare(before) === bare(after)) continue;
        const change: GenreChange = {
          id: crypto.randomUUID(),
          key: r.key,
          source: r.source,
          at: new Date().toISOString(),
          actor: meta.actor,
          reason: meta.reason,
          ...(meta.batchId ? { batchId: meta.batchId } : {}),
          before: before && clone(before),
          after: after && clone(after),
        };
        state.genreChanges.push(change);
        changes.push(clone(change));
      }
    });
    return changes;
  }

  async listGenreChanges(q: GenreChangeQuery): Promise<GenreChange[]> {
    const newest = [...((await this.load()).genreChanges ?? [])].reverse();
    let batchId = q.batchId;
    if (q.latestBatchReason !== undefined) {
      batchId = newest.find((c) => c.reason === q.latestBatchReason && !c.undoneAt && c.batchId)?.batchId;
      if (!batchId) return [];
    }
    const out = newest.filter(
      (c) =>
        (q.key === undefined || c.key === q.key) &&
        (batchId === undefined || c.batchId === batchId) &&
        (q.latestBatchReason === undefined || (c.reason === q.latestBatchReason && !c.undoneAt)),
    );
    return clone(q.limit === undefined ? out : out.slice(0, q.limit));
  }

  // Only undoneAt may be set, once: a change already undone keeps its first time.
  async markGenreChangesUndone(ids: string[], at: string): Promise<void> {
    const state = await this.load();
    const want = new Set(ids);
    for (const c of state.genreChanges ?? []) if (want.has(c.id) && !c.undoneAt) c.undoneAt = at;
    await this.save();
  }

  // The owner's genre vocabulary (0060), ordered by key, aliases by key, umbrellas sorted.
  async getGenreVocabulary(): Promise<GenreVocabulary> {
    const vocab = (await this.load()).genreVocab ?? {};
    return { genres: vocabImages(vocab, Object.keys(vocab)) };
  }

  // genre_vocabulary_write (0060): the same checks and refusals as the SQL, all or nothing.
  async writeGenreVocabulary(after: GenreVocabWriteRow[], meta: GenreVocabWriteMeta): Promise<GenreVocabChange> {
    if (!Array.isArray(after)) throw new Error('genre_vocabulary_write: p_after must be an array');
    if (!(meta.actor === 'owner' || (typeof meta.actor === 'string' && meta.actor.startsWith('system:')))) {
      throw new Error('genre_vocabulary_write: actor must be owner or system:<job>');
    }
    if (!VOCAB_OPERATIONS.has(meta.operation)) throw new Error(`genre_vocabulary_write: unknown operation ${meta.operation}`);
    if (!meta.reason?.trim() || !meta.summary?.trim()) throw new Error('genre_vocabulary_write: a reason and a summary are required');
    const state = await this.load();
    let change: GenreVocabChange | undefined;
    await this.mutateCanonical(state, () => {
      const vocab = (state.genreVocab ??= {});
      state.genreVocabChanges ??= [];
      const keys = after.map((r) => r.key);
      if (keys.some((k) => typeof k !== 'string' || !k.trim())) throw new Error('genre_vocabulary_write: every entry needs a key');
      if (new Set(keys).size !== keys.length) throw new Error('genre_vocabulary_write: a genre key is listed twice');
      const deleted = new Set(after.filter((r) => !r.image).map((r) => r.key));
      // Touched: the listed genres, and any genre that sits under one being deleted.
      const touched = new Set(keys);
      for (const g of Object.values(vocab)) {
        if (g.umbrellas.some((u) => deleted.has(u)) || (g.primaryParent && deleted.has(g.primaryParent)) || (g.relations ?? []).some((r) => deleted.has(r.target))) touched.add(g.key);
      }
      const before = vocabImages(vocab, [...touched], true);

      // Clear the listed genres' own links, and delete the genres with no image with every link to them.
      for (const k of keys) {
        const g = lookup(vocab, k);
        if (g) {
          g.aliases = [];
          g.umbrellas = [];
        }
      }
      for (const k of deleted) delete vocab[k];
      for (const g of Object.values(vocab)) g.umbrellas = g.umbrellas.filter((u) => !deleted.has(u));
      // As the foreign keys do: a deleted genre's links go, and a family or genre it parented is left ungrouped.
      for (const g of Object.values(vocab)) {
        if (g.primaryParent && deleted.has(g.primaryParent)) delete g.primaryParent;
        if (g.relations) {
          g.relations = g.relations.filter((r) => !deleted.has(r.target));
          if (!g.relations.length) delete g.relations;
        }
      }

      const aliasOwner = (aliasKey: string) => Object.values(vocab).find((g) => g.aliases.some((a) => a.key === aliasKey));
      // Every genre with an image first, so links between listed genres resolve.
      for (const r of after) {
        if (!r.image) continue;
        const name = typeof r.image.name === 'string' ? r.image.name.trim() : '';
        if (!name) throw new Error(`genre_vocabulary_write: genre ${r.key} needs a name`);
        if (aliasOwner(r.key)) throw new Error(`genre_vocabulary_write: ${r.key} is already another genre's alias`);
        const parent = typeof r.image.parent === 'string' ? r.image.parent.trim() : '';
        // An image with a level sets the taxonomy; one without keeps the genre's taxonomy as it is.
        const taxonomy = taxonomyOf(r.image.level !== undefined ? r.image : (lookup(vocab, r.key) ?? {}));
        vocab[r.key] = { key: r.key, name, ...(parent ? { parent } : {}), ...taxonomy, aliases: [], umbrellas: [] };
      }
      for (const r of after) {
        if (!r.image) continue;
        const g = vocab[r.key];
        for (const a of r.image.aliases ?? []) {
          const aliasKey = typeof a?.key === 'string' ? a.key : '';
          const alias = typeof a?.alias === 'string' ? a.alias.trim() : '';
          if (!aliasKey.trim() || !alias) throw new Error(`genre_vocabulary_write: an alias of ${r.key} needs a key and a spelling`);
          if (has(vocab, aliasKey)) throw new Error(`genre_vocabulary_write: alias key ${aliasKey} is already a genre key`);
          if (aliasOwner(aliasKey)) throw new Error(`genre_vocabulary_write: alias key ${aliasKey} is already an alias of another genre`);
          g.aliases.push({ key: aliasKey, alias });
        }
        for (const u of r.image.umbrellas ?? []) {
          if (u === r.key) throw new Error(`genre_vocabulary_write: ${r.key} cannot sit under itself`);
          if (!has(vocab, u)) throw new Error(`genre_vocabulary_write: umbrella ${u} is not a genre`);
          if (!g.umbrellas.includes(u)) g.umbrellas.push(u);
        }
      }

      // Umbrella loops: walk up from each new link's umbrella; reaching the genre itself is a loop.
      for (const k of keys) {
        for (const u of lookup(vocab, k)?.umbrellas ?? []) {
          const seen = new Set<string>();
          const todo = [u];
          while (todo.length) {
            const at = todo.pop()!;
            if (at === k) throw new Error(`genre_vocabulary_write: putting ${k} under ${u} makes an umbrella loop`);
            if (seen.has(at)) continue;
            seen.add(at);
            todo.push(...(lookup(vocab, at)?.umbrellas ?? []));
          }
        }
      }

      change = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        actor: meta.actor,
        operation: meta.operation,
        reason: meta.reason,
        summary: meta.summary,
        before,
        after: vocabImages(vocab, [...touched], true),
      };
      state.genreVocabChanges.push(change);
    });
    return clone(change!);
  }

  async listGenreVocabChanges(q: GenreVocabChangeQuery): Promise<GenreVocabChange[]> {
    const newest = [...((await this.load()).genreVocabChanges ?? [])].reverse().filter((c) => q.id === undefined || c.id === q.id);
    return clone(q.limit === undefined ? newest : newest.slice(0, q.limit));
  }

  // Only undoneAt may be set, once: a change already undone keeps its first time.
  async markGenreVocabChangesUndone(ids: string[], at: string): Promise<void> {
    const state = await this.load();
    const want = new Set(ids);
    for (const c of state.genreVocabChanges ?? []) if (want.has(c.id) && !c.undoneAt) c.undoneAt = at;
    await this.save();
  }

  // seen_act_names() (0059): one row per key across every member's live events, the lowest spelling,
  // key and name only. Empty keys and names and vault ciphertext are skipped.
  async listSeenActNames(): Promise<Array<{ key: string; name: string }>> {
    const names = new Map<string, string>();
    for (const e of Object.values((await this.load()).events)) {
      if (e.deletedAt || !Array.isArray(e.seen)) continue;
      for (const a of e.seen) {
        const key = typeof a?.key === 'string' ? a.key.trim() : '';
        const name = typeof a?.name === 'string' ? a.name.trim() : '';
        if (!key || !name || a.name.startsWith('v1:')) continue;
        const had = names.get(key);
        if (had === undefined || name < had) names.set(key, name);
      }
    }
    return [...names].map(([key, name]) => ({ key, name }));
  }

  // canonical_artist_cleanup() (0060): single-transaction parity for tests and local store.
  async runArtistCleanup(
    rows: ArtistCleanupRow[],
    opts: { dryRun: boolean; actor: string; reason: string },
    ownerUserId?: string,
  ): Promise<ArtistCleanupReport> {
    const state = await this.load();
    const snapshot = clone(state);
    try {
      state.artists ??= {};
      state.aliases ??= {};
      state.blocklist ??= [];
      state.artistGenres ??= {};
      state.genreChanges ??= [];
      state.owners ??= {};

      const counts = emptyStatusCounts();
      const failedResolutions: ArtistCleanupReport['failedResolutions'] = [];
      let performancesMigrated = 0;
      let performancesDeduped = 0;
      let newArtistsInserted = 0;
      let parentStubsInserted = 0;
      let ownerEventsUpdated = 0;
      const deprecatedKeys: string[] = [];
      const invalidNorms = new Set<string>();

      // Pre-rename snapshot so artist:<Original> targets resolve pre-rename names.
      const origByName = new Map<string, ArtistIdentity>();
      for (const a of Object.values(state.artists)) {
        if (!origByName.has(a.name)) origByName.set(a.name, clone(a));
      }

      // Universe fallback: acts in seen_act_names(), artist_genres, or owner entities without a canonical_artists row.
      const universeByKey = new Map<string, string>();
      for (const ev of Object.values(state.events)) {
        if (ev.deletedAt || !Array.isArray(ev.seen)) continue;
        for (const a of ev.seen) {
          const k = typeof a?.key === 'string' ? a.key.trim() : '';
          const n = typeof a?.name === 'string' ? a.name.trim() : '';
          if (k && n && !a.name.startsWith('v1:') && !universeByKey.has(k)) universeByKey.set(k, n);
        }
      }
      for (const g of Object.values(state.artistGenres)) {
        if (g.key && g.name?.trim() && !universeByKey.has(g.key)) universeByKey.set(g.key, g.name.trim());
      }
      const entHolder = this.holder(state, ownerUserId);
      for (const e of Object.values(entHolder.entities ?? {})) {
        if (e.kind === 'artist' && !e.mergedIntoId && e.nameNormalized && e.name && !universeByKey.has(e.nameNormalized)) {
          universeByKey.set(e.nameNormalized, e.name);
        }
      }
      const findUniverse = (name: string, key: string): { key: string; name: string } | undefined => {
        for (const [k, n] of universeByKey) {
          if (n === name || (key && k === key)) return { key: k, name: n };
        }
        return undefined;
      };

      const findSource = (mbid: string, artist: string, artistKey: string): ArtistIdentity | undefined => {
        if (mbid) {
          const byMbid = Object.values(state.artists).find((a) => a.mbid === mbid);
          if (byMbid) return byMbid;
        }
        const byName = Object.values(state.artists).find((a) => a.name === artist);
        if (byName) return byName;
        if (artistKey) return state.artists[artistKey];
        return undefined;
      };

      const findTarget = (rawKey: string, normKey: string, allowUniverse = false): ArtistIdentity | undefined => {
        if (rawKey.startsWith('mbid:')) {
          const mbid = rawKey.slice('mbid:'.length);
          return Object.values(state.artists).find((a) => a.mbid === mbid);
        }
        if (rawKey.startsWith('artist:')) {
          const rawName = rawKey.slice('artist:'.length);
          const orig = origByName.get(rawName);
          if (orig && state.artists[orig.key]) return state.artists[orig.key];
          if (normKey && state.artists[normKey]) return state.artists[normKey];
          if (allowUniverse) {
            const u = findUniverse(rawName, normKey);
            if (u) {
              const promoted: ArtistIdentity = { key: u.key, name: u.name };
              state.artists[u.key] = promoted;
              return promoted;
            }
          }
        }
        return undefined;
      };

      const isOwnerEvent = (eventId: string): boolean => {
        if (!ownerUserId) return true;
        const owner = state.owners?.[`event:${eventId}`];
        return owner === undefined || owner === ownerUserId;
      };

      const recordGenreDelete = (artistKey: string, tag: string) => {
        for (const [id, g] of Object.entries(state.artistGenres ?? {})) {
          if (g.key !== artistKey) continue;
          state.genreChanges!.push({
            id: crypto.randomUUID(),
            key: g.key,
            source: g.source,
            at: new Date().toISOString(),
            actor: opts.actor as GenreChange['actor'],
            reason: `${opts.reason} (${tag})`,
            before: clone(g),
            after: null,
          });
          delete state.artistGenres![id];
        }
      };

      const order = ['invalid_non_artist', 'merge_duplicate', 'remap_set', 'split_multi_artist', 'rename', 'link_alter_ego'] as const;
      const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.line - b.line);

      for (const r of sorted) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
        const src = findSource(r.mbid, r.artist, r.artistKey);

        if (r.status === 'invalid_non_artist') {
          const norm = r.artistKey || r.artist.trim().toLowerCase();
          invalidNorms.add(norm);
          const existingBl = state.blocklist.find((b) => b.domain === '*' && b.normalized === norm);
          if (existingBl) {
            existingBl.rejections += 1;
            if (r.invalidReason) existingBl.reason = r.invalidReason;
          } else {
            state.blocklist.push({ domain: '*', normalized: norm, rejections: 1, ...(r.invalidReason ? { reason: r.invalidReason } : {}) });
          }
          if (src) {
            deprecatedKeys.push(src.key);
            for (const ed of Object.values(state.editions)) {
              ed.performances = ed.performances.filter((p) => p.artistKey !== src.key);
            }
            recordGenreDelete(src.key, 'invalid_non_artist');
            for (const a of Object.values(state.artists)) {
              if (a.alterEgoOf === src.key) delete a.alterEgoOf;
            }
            delete state.artists[src.key];
          }
          for (const ev of Object.values(state.events)) {
            if (ev.deletedAt || !Array.isArray(ev.seen) || !isOwnerEvent(ev.id)) continue;
            const next = ev.seen.filter((s) => !((src && s.key === src.key) || (r.artistKey && s.key === r.artistKey) || s.name === r.artist));
            if (next.length !== ev.seen.length) {
              ev.seen = next;
              ownerEventsUpdated += 1;
            }
          }
        } else if (r.status === 'merge_duplicate' || r.status === 'remap_set') {
          const tgt = findTarget(r.canonicalKey, r.canonicalTargetKey, true);
          if (!tgt) {
            failedResolutions.push({ line: r.line, artist: r.artist, status: r.status, targetKey: r.canonicalKey, reason: 'Target artist not found' });
            continue;
          }
          if (r.artistKey && r.artistKey !== tgt.key) {
            state.aliases[r.artistKey] = tgt.name;
          }
          if (src && src.key !== tgt.key) {
            deprecatedKeys.push(src.key);
            if (r.status === 'merge_duplicate' && src.mbid && !tgt.mbid) {
              tgt.mbid = src.mbid;
            }
            for (const ed of Object.values(state.editions)) {
              const moved: EditionPerformance[] = [];
              for (const p of ed.performances) {
                if (p.artistKey !== src.key) {
                  moved.push(p);
                  continue;
                }
                const existing = ed.performances.find((x) => x !== p && x.artistKey === tgt.key && (x.slotId ?? '') === (p.slotId ?? ''));
                if (existing) {
                  existing.days = [...new Set([...existing.days, ...p.days])].sort();
                  existing.stages = [...new Set([...existing.stages, ...p.stages])];
                  existing.billing = existing.billing ?? p.billing;
                  existing.sources = [...existing.sources, ...p.sources];
                  if (r.status === 'remap_set' && !existing.set) existing.set = r.setQualifier || p.set;
                  performancesDeduped += 1;
                } else {
                  moved.push({
                    ...p,
                    artistKey: tgt.key,
                    name: tgt.name,
                    ...(r.status === 'remap_set' && r.setQualifier ? { set: r.setQualifier } : {}),
                  });
                  performancesMigrated += 1;
                }
              }
              ed.performances = moved;
            }
            if (r.status === 'merge_duplicate') {
              for (const g of Object.values(state.artistGenres)) {
                if (g.key !== src.key) continue;
                const tgtId = `${g.source}|${tgt.key}`;
                if (!state.artistGenres[tgtId]) {
                  const copied: ArtistGenres = { ...clone(g), key: tgt.key, name: tgt.name, ...(tgt.mbid ? { mbid: tgt.mbid } : {}) };
                  state.artistGenres[tgtId] = copied;
                  state.genreChanges.push({
                    id: crypto.randomUUID(),
                    key: tgt.key,
                    source: g.source,
                    at: new Date().toISOString(),
                    actor: opts.actor as GenreChange['actor'],
                    reason: `${opts.reason} (merge_duplicate copy)`,
                    before: null,
                    after: clone(copied),
                  });
                }
              }
            }
            recordGenreDelete(src.key, r.status);
            for (const [ak, av] of Object.entries(state.aliases)) {
              if (av === src.name) state.aliases[ak] = tgt.name;
            }
            for (const a of Object.values(state.artists)) {
              if (a.alterEgoOf === src.key) a.alterEgoOf = tgt.key;
            }
            delete state.artists[src.key];
          }
          for (const ev of Object.values(state.events)) {
            if (ev.deletedAt || !Array.isArray(ev.seen) || !isOwnerEvent(ev.id)) continue;
            let changed = false;
            for (const s of ev.seen) {
              if ((src && s.key === src.key) || (r.artistKey && s.key === r.artistKey) || s.name === r.artist) {
                changed = true;
                s.key = tgt.key;
                s.name = tgt.name;
                if (r.status === 'remap_set' && r.setQualifier && !s.set) s.set = r.setQualifier;
              }
            }
            if (changed) ownerEventsUpdated += 1;
          }
        } else if (r.status === 'split_multi_artist') {
          const resolved: ArtistIdentity[] = [];
          for (const item of r.splitItems) {
            let t = findTarget(item.key, item.normalizedKey);
            if (!t && item.key === 'NEW' && item.normalizedKey) {
              t = state.artists[item.normalizedKey];
              if (!t) {
                t = { key: item.normalizedKey, name: item.name };
                state.artists[t.key] = t;
                newArtistsInserted += 1;
              }
            }
            if (!t) {
              failedResolutions.push({ line: r.line, artist: r.artist, status: r.status, targetKey: item.key, reason: `Split constituent not found: ${item.name}` });
            } else {
              resolved.push(t);
            }
          }
          if (resolved.length < 2) continue;

          if (src) {
            deprecatedKeys.push(src.key);
            for (const ed of Object.values(state.editions)) {
              const nextPerfs: EditionPerformance[] = [];
              for (const p of ed.performances) {
                if (p.artistKey !== src.key) {
                  nextPerfs.push(p);
                  continue;
                }
                const slotId = p.slotId || crypto.randomUUID();
                for (let i = 0; i < resolved.length; i++) {
                  const c = resolved[i];
                  const b2b = resolved.filter((_, idx) => idx !== i).map((x) => x.key);
                  const existing = ed.performances.find((x) => x.artistKey === c.key && (x.slotId ?? '') === slotId);
                  if (existing) {
                    if (r.comboAlias && !existing.alias) existing.alias = r.comboAlias;
                    if ((r.setQualifier || p.set) && !existing.set) existing.set = r.setQualifier || p.set;
                    performancesDeduped += 1;
                  } else {
                    nextPerfs.push({
                      ...clone(p),
                      artistKey: c.key,
                      name: c.name,
                      slotId,
                      b2b,
                      ...(r.comboAlias ? { alias: r.comboAlias } : {}),
                      ...(r.setQualifier || p.set ? { set: r.setQualifier || p.set } : {}),
                    });
                    performancesMigrated += 1;
                  }
                }
              }
              ed.performances = nextPerfs;
            }
            recordGenreDelete(src.key, 'split_multi_artist');
            for (const a of Object.values(state.artists)) {
              if (a.alterEgoOf === src.key) delete a.alterEgoOf;
            }
            delete state.artists[src.key];
          }
          for (const ev of Object.values(state.events)) {
            if (ev.deletedAt || !Array.isArray(ev.seen) || !isOwnerEvent(ev.id)) continue;
            let changed = false;
            const nextSeen: typeof ev.seen = [];
            for (const s of ev.seen) {
              if ((src && s.key === src.key) || (r.artistKey && s.key === r.artistKey) || s.name === r.artist) {
                changed = true;
                const slotId = s.slotId || crypto.randomUUID();
                for (let i = 0; i < resolved.length; i++) {
                  const c = resolved[i];
                  const b2b = resolved.filter((_, idx) => idx !== i).map((x) => x.key);
                  nextSeen.push({
                    ...clone(s),
                    key: c.key,
                    name: c.name,
                    slotId,
                    b2b,
                    ...(r.comboAlias ? { alias: r.comboAlias } : {}),
                    ...(r.setQualifier ? { set: r.setQualifier } : {}),
                  });
                }
              } else {
                nextSeen.push(s);
              }
            }
            if (changed) {
              ev.seen = nextSeen;
              ownerEventsUpdated += 1;
            }
          }
        } else if (r.status === 'rename') {
          let effectiveSrc = src;
          if (!effectiveSrc) {
            const univ = findUniverse(r.artist, r.artistKey);
            if (!univ) {
              failedResolutions.push({ line: r.line, artist: r.artist, status: r.status, targetKey: r.canonicalArtist, reason: 'Source artist not found' });
              continue;
            }
            const nextKey = r.canonicalNewKey || univ.key;
            if (nextKey !== univ.key) {
              for (const g of Object.values(state.artistGenres)) {
                if (g.key !== univ.key) continue;
                const tgtId = `${g.source}|${nextKey}`;
                if (!state.artistGenres[tgtId]) {
                  const moved: ArtistGenres = { ...clone(g), key: nextKey, name: r.canonicalArtist };
                  state.artistGenres[tgtId] = moved;
                  state.genreChanges.push({
                    id: crypto.randomUUID(),
                    key: nextKey,
                    source: g.source,
                    at: new Date().toISOString(),
                    actor: opts.actor as GenreChange['actor'],
                    reason: `${opts.reason} (rename move)`,
                    before: null,
                    after: clone(moved),
                  });
                }
              }
              recordGenreDelete(univ.key, 'rename');
            }
            if (r.artistKey && r.artistKey !== nextKey) state.aliases[r.artistKey] = r.canonicalArtist;
            for (const [ak, av] of Object.entries(state.aliases)) {
              if (av === r.artist) state.aliases[ak] = r.canonicalArtist;
            }
            for (const ev of Object.values(state.events)) {
              if (ev.deletedAt || !Array.isArray(ev.seen) || !isOwnerEvent(ev.id)) continue;
              let changed = false;
              for (const s of ev.seen) {
                if (s.key === univ.key || (r.artistKey && s.key === r.artistKey) || s.name === r.artist) {
                  changed = true;
                  s.key = nextKey;
                  s.name = r.canonicalArtist;
                  if (r.setQualifier && !s.set) s.set = r.setQualifier;
                }
              }
              if (changed) ownerEventsUpdated += 1;
            }
            if (!r.alterEgoOf) continue;
            effectiveSrc = state.artists[nextKey] ?? (state.artists[nextKey] = { key: nextKey, name: r.canonicalArtist });
          }
          let finalArtist = effectiveSrc;
          if (!r.canonicalNewKey || r.canonicalNewKey === effectiveSrc.key) {
            effectiveSrc.name = r.canonicalArtist;
            if (r.setQualifier) {
              for (const ed of Object.values(state.editions)) {
                for (const p of ed.performances) {
                  if (p.artistKey === effectiveSrc.key && !p.set) p.set = r.setQualifier;
                }
              }
            }
          } else {
            let tgt = state.artists[r.canonicalNewKey];
            if (!tgt) {
              tgt = { ...clone(effectiveSrc), key: r.canonicalNewKey, name: r.canonicalArtist };
              state.artists[tgt.key] = tgt;
            } else if (effectiveSrc.mbid && !tgt.mbid) {
              tgt.mbid = effectiveSrc.mbid;
            }
            for (const ed of Object.values(state.editions)) {
              const nextPerfs: EditionPerformance[] = [];
              for (const p of ed.performances) {
                if (p.artistKey !== effectiveSrc.key) {
                  nextPerfs.push(p);
                  continue;
                }
                const existing = ed.performances.find((x) => x !== p && x.artistKey === tgt.key && (x.slotId ?? '') === (p.slotId ?? ''));
                if (existing) {
                  existing.days = [...new Set([...existing.days, ...p.days])].sort();
                  existing.stages = [...new Set([...existing.stages, ...p.stages])];
                  existing.sources = [...existing.sources, ...p.sources];
                  if (r.setQualifier && !existing.set) existing.set = r.setQualifier;
                  performancesDeduped += 1;
                } else {
                  nextPerfs.push({ ...p, artistKey: tgt.key, name: r.canonicalArtist, ...(r.setQualifier && !p.set ? { set: r.setQualifier } : {}) });
                  performancesMigrated += 1;
                }
              }
              ed.performances = nextPerfs;
            }
            for (const g of Object.values(state.artistGenres)) {
              if (g.key !== effectiveSrc.key) continue;
              const tgtId = `${g.source}|${tgt.key}`;
              if (!state.artistGenres[tgtId]) {
                const moved: ArtistGenres = { ...clone(g), key: tgt.key, name: r.canonicalArtist };
                state.artistGenres[tgtId] = moved;
                state.genreChanges.push({
                  id: crypto.randomUUID(),
                  key: tgt.key,
                  source: g.source,
                  at: new Date().toISOString(),
                  actor: opts.actor as GenreChange['actor'],
                  reason: `${opts.reason} (rename move)`,
                  before: null,
                  after: clone(moved),
                });
              }
            }
            recordGenreDelete(effectiveSrc.key, 'rename');
            for (const a of Object.values(state.artists)) {
              if (a.alterEgoOf === effectiveSrc.key) a.alterEgoOf = tgt.key;
            }
            delete state.artists[effectiveSrc.key];
            finalArtist = tgt;
          }
          if (r.artistKey && r.artistKey !== finalArtist.key) state.aliases[r.artistKey] = r.canonicalArtist;
          for (const [ak, av] of Object.entries(state.aliases)) {
            if (av === r.artist) state.aliases[ak] = r.canonicalArtist;
          }
          for (const ev of Object.values(state.events)) {
            if (ev.deletedAt || !Array.isArray(ev.seen) || !isOwnerEvent(ev.id)) continue;
            let changed = false;
            for (const s of ev.seen) {
              if ((r.artistKey && s.key === r.artistKey) || s.name === r.artist) {
                changed = true;
                s.key = finalArtist.key;
                s.name = r.canonicalArtist;
                if (r.setQualifier && !s.set) s.set = r.setQualifier;
              }
            }
            if (changed) ownerEventsUpdated += 1;
          }
          if (r.alterEgoOf) {
            let parent = findTarget(r.alterEgoOfKey, r.alterEgoTargetKey);
            if (!parent && r.alterEgoOfKey === 'NEW' && r.alterEgoTargetKey) {
              parent = state.artists[r.alterEgoTargetKey];
              if (!parent) {
                parent = { key: r.alterEgoTargetKey, name: r.alterEgoOf };
                state.artists[parent.key] = parent;
                parentStubsInserted += 1;
              }
            }
            if (!parent) {
              failedResolutions.push({ line: r.line, artist: r.artist, status: r.status, targetKey: r.alterEgoOfKey, reason: `Alter-ego parent not found: ${r.alterEgoOf}` });
            } else {
              finalArtist.alterEgoOf = parent.key;
            }
          }
        } else if (r.status === 'link_alter_ego') {
          let effectiveSrc = src;
          if (!effectiveSrc) {
            const univ = findUniverse(r.artist, r.artistKey);
            if (univ) {
              effectiveSrc = state.artists[univ.key] ?? (state.artists[univ.key] = { key: univ.key, name: univ.name });
            }
          }
          if (!effectiveSrc) {
            failedResolutions.push({ line: r.line, artist: r.artist, status: r.status, targetKey: r.artist, reason: 'Alter-ego artist not found' });
            continue;
          }
          let parent = findTarget(r.alterEgoOfKey, r.alterEgoTargetKey);
          if (!parent && r.alterEgoOfKey === 'NEW' && r.alterEgoTargetKey) {
            parent = state.artists[r.alterEgoTargetKey];
            if (!parent) {
              parent = { key: r.alterEgoTargetKey, name: r.alterEgoOf };
              state.artists[parent.key] = parent;
              parentStubsInserted += 1;
            }
          }
          if (!parent) {
            failedResolutions.push({ line: r.line, artist: r.artist, status: r.status, targetKey: r.alterEgoOfKey, reason: `Alter-ego parent not found: ${r.alterEgoOf}` });
          } else {
            effectiveSrc.alterEgoOf = parent.key;
          }
        }
      }

      const remainingDeprecatedActive = deprecatedKeys.filter((k) => Boolean(state.artists[k])).length;
      const orphanedPerformances = Object.values(state.editions)
        .flatMap((e) => e.performances)
        .filter((p) => !state.artists[p.artistKey]).length;
      const missingBlocklistEntries = [...invalidNorms].filter((n) => !state.blocklist.some((b) => b.domain === '*' && b.normalized === n)).length;

      const report: ArtistCleanupReport = {
        dryRun: opts.dryRun,
        counts,
        totalRows: sorted.length,
        performancesMigrated,
        performancesDeduped,
        newArtistsInserted,
        parentStubsInserted,
        ownerEventsUpdated,
        failedResolutions,
        assertions: {
          remainingDeprecatedActive,
          orphanedPerformances,
          missingBlocklistEntries,
        },
      };

      if (opts.dryRun) {
        this.state = snapshot;
      } else {
        await this.save();
      }
      return report;
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }

  // The entity tables of one member (Supabase: user_entities and friends), or
  // of the single-owner app (the state itself) when uid is undefined.
  private holder(state: FileState, uid?: string): Pick<FileState, 'entities' | 'entityAliases' | 'entityLinks' | 'entityHistory'> {
    if (!uid) return state;
    state.userEntities ??= {};
    return (state.userEntities[uid] ??= {});
  }

  async listEntitiesFor(uid: string | undefined) {
    const state = await this.load();
    return clone(Object.values(this.holder(state, uid).entities ?? {}));
  }

  async addEntitiesFor(uid: string | undefined, entities: Entity[]) {
    const state = await this.load();
    const h = this.holder(state, uid);
    const all = new Map(Object.entries(h.entities ?? {}));
    const fresh = [...new Map(entities.filter((e) => !all.has(e.id)).map((e) => [e.id, e])).values()];
    checkEntities(all, fresh);
    h.entities = { ...h.entities };
    for (const e of fresh) h.entities[e.id] = clone(e);
    await this.save();
  }

  async listEntityAliasesFor(uid: string | undefined) {
    const state = await this.load();
    return clone(this.holder(state, uid).entityAliases ?? []);
  }

  async addEntityAliasesFor(uid: string | undefined, aliases: EntityAlias[]) {
    const state = await this.load();
    const h = this.holder(state, uid);
    const existing = h.entityAliases ?? [];
    const held = new Set(existing.map((a) => `${a.kind}\u0000${a.aliasNormalized}\u0000${a.entityId}`));
    const fresh = aliases.filter((a) => !held.has(`${a.kind}\u0000${a.aliasNormalized}\u0000${a.entityId}`));
    checkAliases(new Map(Object.entries(h.entities ?? {})), existing, fresh);
    const seen = new Set<string>();
    h.entityAliases = [
      ...existing,
      ...fresh.filter((a) => {
        const k = `${a.kind}\u0000${a.aliasNormalized}`;
        return !seen.has(k) && seen.add(k);
      }).map(clone),
    ];
    await this.save();
  }

  async listEntityLinksFor(uid: string | undefined) {
    const state = await this.load();
    return clone(this.holder(state, uid).entityLinks ?? []);
  }

  async addEntityLinksFor(uid: string | undefined, links: EntityLink[]) {
    const state = await this.load();
    const h = this.holder(state, uid);
    const existing = h.entityLinks ?? [];
    const pk = (l: EntityLink) => `${l.fromId}\u0000${l.toId}\u0000${l.role}`;
    const have = new Set(existing.map(pk));
    const fresh = [...new Map(links.filter((l) => !have.has(pk(l))).map((l) => [pk(l), l])).values()];
    checkLinks(new Map(Object.entries(h.entities ?? {})), fresh);
    h.entityLinks = [...existing, ...fresh.map(clone)];
    await this.save();
  }

  async putEntitiesFor(uid: string | undefined, entities: Entity[]) {
    const state = await this.load();
    const h = this.holder(state, uid);
    checkEntities(new Map(Object.entries(h.entities ?? {})), entities);
    h.entities = { ...h.entities };
    for (const e of entities) h.entities[e.id] = clone(e);
    await this.save();
  }

  async replaceEntityAliasesFor(uid: string | undefined, entityIds: string[], aliases: EntityAlias[]) {
    const state = await this.load();
    const h = this.holder(state, uid);
    const ids = new Set(entityIds);
    const kept = (h.entityAliases ?? []).filter((a) => !ids.has(a.entityId));
    checkAliases(new Map(Object.entries(h.entities ?? {})), kept, aliases);
    const seen = new Set<string>();
    const fresh = aliases.filter((a) => {
      const k = `${a.kind}\u0000${a.aliasNormalized}`;
      return !seen.has(k) && Boolean(seen.add(k));
    });
    h.entityAliases = [...kept, ...fresh.map(clone)];
    await this.save();
  }

  async replaceEntityLinksFor(uid: string | undefined, entityIds: string[], links: EntityLink[]) {
    const state = await this.load();
    const h = this.holder(state, uid);
    const ids = new Set(entityIds);
    const kept = (h.entityLinks ?? []).filter((l) => !ids.has(l.fromId) && !ids.has(l.toId));
    checkLinks(new Map(Object.entries(h.entities ?? {})), links);
    const pk = (l: EntityLink) => `${l.fromId}\u0000${l.toId}\u0000${l.role}`;
    const have = new Set(kept.map(pk));
    h.entityLinks = [...kept, ...links.filter((l) => !have.has(pk(l)) && Boolean(have.add(pk(l)))).map(clone)];
    await this.save();
  }

  async deleteEntitiesFor(uid: string | undefined, ids: string[]) {
    if (!uid) throw new Error('Records are only deleted from a member\'s own tables.');
    const state = await this.load();
    const h = this.holder(state, uid);
    const gone = new Set(ids);
    for (const id of gone) delete h.entities?.[id];
    h.entityAliases = (h.entityAliases ?? []).filter((a) => !gone.has(a.entityId));
    h.entityLinks = (h.entityLinks ?? []).filter((l) => !gone.has(l.fromId) && !gone.has(l.toId));
    await this.save();
  }

  async deleteEntityHistoryFor(uid: string | undefined, ids: string[]) {
    const state = await this.load();
    const h = this.holder(state, uid);
    for (const id of ids) delete h.entityHistory?.[id];
    await this.save();
  }

  async putEntityHistoryFor(uid: string | undefined, entry: HistoryEntry) {
    const state = await this.load();
    const h = this.holder(state, uid);
    h.entityHistory = { ...h.entityHistory, [entry.id]: clone(entry) };
    await this.save();
  }

  async getEntityHistoryFor(uid: string | undefined, id: string) {
    const state = await this.load();
    const found = this.holder(state, uid).entityHistory?.[id];
    return found ? clone(found) : null;
  }

  async listEntityHistoryFor(uid: string | undefined, limit: number) {
    const state = await this.load();
    const all = Object.values(this.holder(state, uid).entityHistory ?? {});
    return clone(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  // Owner's canonical history. Two sources, merged by id: entityHistory rows with a canonical operation,
  // and canonicalChanges, where applyCanonicalArtistChange (the 8.6 apply path) keeps its changes. The filter
  // runs on the full set before the cursor and the limit, so an older canonical entry is never skipped.
  async listCanonicalHistoryPage(options: CanonicalHistoryPageOptions = {}): Promise<CanonicalHistoryPage> {
    const limit = normalizeCanonicalHistoryLimit(options.limit);
    const cursor = options.cursor == null ? null : decodeCanonicalHistoryCursor(options.cursor);
    const state = await this.load();
    const byId = new Map<string, CanonicalHistoryEntry>();
    for (const h of Object.values(this.holder(state, undefined).entityHistory ?? {})) {
      if (!isCanonicalOperation(h.operation)) continue;
      byId.set(h.id, {
        id: h.id,
        operation: h.operation,
        createdAt: h.createdAt,
        ...(h.undoneAt ? { undoneAt: h.undoneAt } : {}),
        manifest: clone(h),
      });
    }
    for (const [id, stored] of Object.entries(state.canonicalChanges ?? {})) {
      const entry = stored.entry;
      byId.set(id, {
        id,
        operation: entry.operation,
        createdAt: entry.createdAt,
        ...(stored.undoneAt ? { undoneAt: stored.undoneAt } : {}),
        manifest: clone(entry),
      });
    }
    const rows = [...byId.values()]
      .filter((e) => cursor === null || isOlderThanCursor(e, cursor))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1));
    const entries = rows.slice(0, limit);
    const last = entries[entries.length - 1];
    return {
      entries,
      nextCursor: rows.length > limit && last ? encodeCanonicalHistoryCursor(last) : null,
    };
  }

  async listEntities() {
    return this.listEntitiesFor(undefined);
  }

  async addEntities(entities: Entity[]) {
    return this.addEntitiesFor(undefined, entities);
  }

  async listEntityAliases() {
    return this.listEntityAliasesFor(undefined);
  }

  async addEntityAliases(aliases: EntityAlias[]) {
    return this.addEntityAliasesFor(undefined, aliases);
  }

  async listEntityLinks() {
    return this.listEntityLinksFor(undefined);
  }

  async addEntityLinks(links: EntityLink[]) {
    return this.addEntityLinksFor(undefined, links);
  }

  async putEntities(entities: Entity[]) {
    return this.putEntitiesFor(undefined, entities);
  }

  async replaceEntityAliases(entityIds: string[], aliases: EntityAlias[]) {
    return this.replaceEntityAliasesFor(undefined, entityIds, aliases);
  }

  async replaceEntityLinks(entityIds: string[], links: EntityLink[]) {
    return this.replaceEntityLinksFor(undefined, entityIds, links);
  }

  async deleteEntities(ids: string[]) {
    return this.deleteEntitiesFor(undefined, ids);
  }

  async deleteEntityHistory(ids: string[]) {
    return this.deleteEntityHistoryFor(undefined, ids);
  }

  async putEntityHistory(entry: HistoryEntry) {
    return this.putEntityHistoryFor(undefined, entry);
  }

  async getEntityHistory(id: string) {
    return this.getEntityHistoryFor(undefined, id);
  }

  async listEntityHistory(limit: number) {
    return this.listEntityHistoryFor(undefined, limit);
  }

  async getCachedResponse(key: string, now: Date) {
    const hit = (await this.load()).responseCache?.[key];
    return hit && hit.expiresAt > now.toISOString() ? clone(hit) : null;
  }

  async putCachedResponse(entry: CachedResponse) {
    const state = await this.load();
    const kept = Object.fromEntries(Object.entries(state.responseCache ?? {}).filter(([, v]) => v.expiresAt > entry.fetchedAt));
    state.responseCache = { ...kept, [entry.key]: clone(entry) };
    await this.save();
  }

  async listShareLinks() {
    return clone(Object.values((await this.load()).shareLinks ?? {}));
  }

  async getShareLinkByHash(codeHash: string) {
    const link = Object.values((await this.load()).shareLinks ?? {}).find((l) => l.codeHash === codeHash);
    return link ? clone(link) : null;
  }

  async putShareLink(link: ShareLink) {
    const state = await this.load();
    state.shareLinks = { ...(state.shareLinks ?? {}), [link.id]: clone(link) };
    await this.save();
  }

  async listShareEvents() {
    return (await this.listEvents()).map(shareEventOnly);
  }

  async addAiCall(row: AiCallRow) {
    const state = await this.load();
    state.aiCalls = [...(state.aiCalls ?? []), clone(row)];
    await this.save();
  }

  async listAiCalls(limit: number) {
    const rows = [...((await this.load()).aiCalls ?? [])];
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  async addIngestTrace(row: IngestTraceRow) {
    const state = await this.load();
    state.ingestTraces = [...(state.ingestTraces ?? []), clone(row)];
    await this.save();
  }

  async listIngestTraces(limit: number) {
    const rows = [...((await this.load()).ingestTraces ?? [])];
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  async deleteAiCallsBefore(cutoff: Date) {
    const state = await this.load();
    const iso = cutoff.toISOString();
    const before = state.aiCalls ?? [];
    const kept = before.filter((r) => r.createdAt >= iso);
    if (kept.length === before.length) return 0;
    state.aiCalls = kept;
    await this.save();
    return before.length - kept.length;
  }

  // Shared occurrences (0041, 0042). Same rules as the SQL: unique keys, append-only changes.
  async upsertVenue(v: { name: string; city?: string; region?: string; country?: string }) {
    const state = await this.load();
    const id = venueIdFor(v, normalizeName);
    state.venues ??= {};
    const existing = state.venues[id];
    if (existing) {
      const region = v.region?.trim();
      if (region && !existing.region?.trim()) {
        existing.region = region;
        await this.save();
      }
      return clone(existing);
    }
    const venue: CanonicalVenue = { id, name: v.name, city: v.city, region: v.region, country: v.country, createdAt: new Date().toISOString() };
    state.venues[id] = venue;
    this.putAlias(state, id, normalizeName(v.name));
    await this.save();
    return clone(venue);
  }

  private putAlias(state: FileState, venueId: string, alias: string, source?: string, externalId?: string) {
    state.venueAliases ??= [];
    if (externalId && source) {
      const held = state.venueAliases.find((a) => a.source === source && a.externalId === externalId);
      if (held && held.venueId !== venueId) throw new ExternalIdConflictError(source, externalId, held.venueId);
    }
    if (state.venueAliases.some((a) => a.venueId === venueId && a.aliasNormalized === alias)) return false;
    state.venueAliases.push({ venueId, aliasNormalized: alias, source, externalId });
    return true;
  }

  async findVenueByAlias(aliasNormalized: string) {
    const state = await this.load();
    const ids = new Set((state.venueAliases ?? []).filter((a) => a.aliasNormalized === aliasNormalized).map((a) => a.venueId));
    if (ids.size !== 1) return null;
    const venue = state.venues?.[[...ids][0]];
    return venue ? clone(venue) : null;
  }

  async listVenuesByAlias(aliasNormalized: string) {
    const state = await this.load();
    const ids = [...new Set((state.venueAliases ?? []).filter((a) => a.aliasNormalized === aliasNormalized).map((a) => a.venueId))];
    return ids.map((id) => state.venues?.[id]).filter((v): v is CanonicalVenue => Boolean(v)).map((v) => clone(v));
  }

  async addVenueAlias(venueId: string, aliasNormalized: string, source?: string, externalId?: string) {
    const state = await this.load();
    if (!state.venues?.[venueId]) throw new Error(`addVenueAlias: venue ${venueId} not found`);
    if (this.putAlias(state, venueId, aliasNormalized, source, externalId)) await this.save();
  }

  async findEditionByExternalId(source: string, externalId: string) {
    const state = await this.load();
    const hit = (state.editionExternalIds ?? []).find((r) => r.source === source && r.externalId === externalId);
    const edition = hit ? state.editions[hit.editionId] : undefined;
    return edition ? clone(edition) : null;
  }

  async addEditionExternalId(editionId: string, source: string, externalId: string) {
    const state = await this.load();
    if (!state.editions[editionId]) throw new Error(`addEditionExternalId: edition ${editionId} not found`);
    state.editionExternalIds ??= [];
    const held = state.editionExternalIds.find((r) => r.source === source && r.externalId === externalId);
    if (held) {
      if (held.editionId !== editionId) throw new ExternalIdConflictError(source, externalId, held.editionId);
      return 'exists' as const;
    }
    state.editionExternalIds.push({ editionId, source, externalId });
    await this.save();
    return 'added' as const;
  }

  async recordEditionChange(c: { editionId: string; actor: string; reason?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }) {
    assertNoPersonalFields(c.before);
    assertNoPersonalFields(c.after);
    const state = await this.load();
    const row = this.pushChange(state, c);
    await this.save();
    return clone(row);
  }

  private pushChange(state: FileState, c: { editionId: string; actor: string; reason?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }) {
    const row: EditionChange = { id: crypto.randomUUID(), editionId: c.editionId, at: new Date().toISOString(), actor: c.actor || 'system', reason: c.reason, before: c.before, after: c.after };
    (state.editionChanges ??= []).push(clone(row));
    return row;
  }

  async listEditionChanges(editionId: string) {
    const rows = ((await this.load()).editionChanges ?? []).filter((r) => r.editionId === editionId);
    return clone([...rows].reverse().sort((a, b) => b.at.localeCompare(a.at)));
  }

  async markChangeUndone(changeId: string) {
    const state = await this.load();
    const row = (state.editionChanges ?? []).find((r) => r.id === changeId);
    if (!row || row.undoneAt) return false;
    row.undoneAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async addEditionInference(i: NewEditionInference): Promise<EditionInference> {
    if (!i.reason || !i.reason.trim()) throw new Error('An inference needs a reason.');
    assertNoPersonalFields(i.value);
    assertNoPersonalFields(i.inputs);
    const state = await this.load();
    const rows = state.editionInferences ?? [];
    const sameSubject = (r: EditionInference) => (r.subject ?? '') === (i.subject ?? '');
    if (rows.some((r) => r.editionId === i.editionId && r.field === i.field && sameSubject(r) && r.status === 'active')) {
      throw new Error(`An active inference already exists for ${i.editionId} ${i.field}${i.subject ? ` ${i.subject}` : ''}.`);
    }
    const row: EditionInference = { ...clone(i), id: crypto.randomUUID(), status: 'active', createdAt: new Date().toISOString() };
    (state.editionInferences ??= []).push(row);
    await this.save();
    return clone(row);
  }

  async listEditionInferences(editionId: string): Promise<EditionInference[]> {
    const rows = ((await this.load()).editionInferences ?? []).filter((r) => r.editionId === editionId);
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async listInferenceChildren(id: string): Promise<EditionInference[]> {
    const rows = ((await this.load()).editionInferences ?? []).filter((r) => r.parents.includes(id));
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async resolveEditionInference(id: string, r: { status: Exclude<InferenceStatus, 'active'>; by: string; reason: string }): Promise<EditionInference | null> {
    const state = await this.load();
    const row = (state.editionInferences ?? []).find((x) => x.id === id);
    if (!row || row.status !== 'active') return null;
    row.status = r.status;
    row.resolvedAt = new Date().toISOString();
    row.resolvedBy = r.by;
    row.resolvedReason = r.reason;
    await this.save();
    return clone(row);
  }

  async getEditionInference(id: string): Promise<EditionInference | null> {
    const row = ((await this.load()).editionInferences ?? []).find((x) => x.id === id);
    return row ? clone(row) : null;
  }

  async reactivateEditionInference(id: string, r: { by: string; reason: string }): Promise<EditionInference | null> {
    const state = await this.load();
    const rows = state.editionInferences ?? [];
    const row = rows.find((x) => x.id === id);
    if (!row || row.status !== 'confirmed') return null;
    const sameSlot = (x: EditionInference) => x.editionId === row.editionId && x.field === row.field && (x.subject ?? '') === (row.subject ?? '');
    if (rows.some((x) => x.id !== id && x.status === 'active' && sameSlot(x))) return null;
    row.status = 'active';
    delete row.resolvedAt;
    delete row.resolvedBy;
    delete row.resolvedReason;
    await this.save();
    return clone(row);
  }

  async listActiveInferences(): Promise<EditionInference[]> {
    const rows = ((await this.load()).editionInferences ?? []).filter((r) => r.status === 'active');
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200));
  }

  async addInferenceVote(inferenceId: string, memberId: string): Promise<InferenceVote> {
    const state = await this.load();
    const existing = (state.inferenceVotes ?? []).find((v) => v.inferenceId === inferenceId && v.memberId === memberId);
    if (existing) return clone(existing);
    const row: InferenceVote = { id: crypto.randomUUID(), inferenceId, memberId, createdAt: new Date().toISOString() };
    (state.inferenceVotes ??= []).push(row);
    await this.save();
    return clone(row);
  }

  async listInferenceVotesFor(inferenceIds: string[]): Promise<InferenceVote[]> {
    const ids = new Set(inferenceIds);
    if (!ids.size) return [];
    const rows = ((await this.load()).inferenceVotes ?? []).filter((v) => ids.has(v.inferenceId));
    return clone(rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  async listInferenceVotes(inferenceId: string): Promise<InferenceVote[]> {
    const rows = ((await this.load()).inferenceVotes ?? []).filter((v) => v.inferenceId === inferenceId);
    return clone(rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  async addReviewItem(i: { kind: ReviewQueueKind; editionId?: string; eventId?: string; payload: Record<string, unknown> }) {
    assertNoPersonalFields(i.payload);
    const state = await this.load();
    const row: ReviewQueueItem = { id: crypto.randomUUID(), kind: i.kind, editionId: i.editionId, eventId: i.eventId, payload: clone(i.payload), status: 'open', createdAt: new Date().toISOString() };
    (state.reviewQueue ??= []).push(row);
    await this.save();
    return clone(row);
  }

  async enqueueReview(i: { kind: ReviewQueueKind; editionId?: string; eventId?: string; payload: Record<string, unknown> }) {
    return this.addReviewItem(i);
  }

  async listReviewItems(q: { status?: string; kind?: ReviewQueueKind } = {}) {
    const rows = ((await this.load()).reviewQueue ?? []).filter((r) => (!q.status || r.status === q.status) && (!q.kind || r.kind === q.kind));
    return clone(rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  async resolveReviewItem(id: string, resolvedBy: string, status: string) {
    const state = await this.load();
    const row = (state.reviewQueue ?? []).find((r) => r.id === id);
    if (!row || row.status !== 'open') return false;
    row.status = status;
    row.resolvedBy = resolvedBy;
    row.resolvedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  // In-memory twin of merge_editions (0042): move, record, delete. All checks run before the first write.
  async mergeEditions(keepId: string, dropId: string, actor: string, reason?: string): Promise<MergeSummary> {
    if (!keepId || !dropId) throw new Error('merge_editions: both ids are required');
    if (keepId === dropId) throw new Error('merge_editions: keep_id and drop_id are the same edition');
    const state = await this.load();
    const keep = state.editions[keepId];
    const drop = state.editions[dropId];
    if (!keep) throw new Error(`merge_editions: edition ${keepId} not found`);
    if (!drop) throw new Error(`merge_editions: edition ${dropId} not found`);
    const before = clone(drop);
    let eventsMoved = 0;
    for (const e of Object.values(state.events)) if (e.editionId === dropId) { e.editionId = keepId; eventsMoved++; }
    const slot = (p: { artistKey: string; slotId?: string }) => `${p.artistKey}|${p.slotId ?? ''}`;
    const have = new Set(keep.performances.map(slot));
    let dup = 0;
    let moved = 0;
    for (const p of drop.performances) {
      if (have.has(slot(p))) dup++;
      else { keep.performances.push(p); have.add(slot(p)); moved++; }
    }
    let ext = 0;
    for (const r of state.editionExternalIds ?? []) if (r.editionId === dropId) { r.editionId = keepId; ext++; }
    let review = 0;
    for (const r of state.reviewQueue ?? []) if (r.editionId === dropId) { r.editionId = keepId; review++; }
    let jobs = 0;
    for (const j of Object.values(state.jobs) as Array<{ editionId?: string }>) if (j.editionId === dropId) { j.editionId = keepId; jobs++; }
    const summary: MergeSummary = {
      keep_id: keepId, drop_id: dropId, events_moved: eventsMoved, attendance_moved: 0,
      performances_moved: moved, performances_duplicate_dropped: dup,
      external_ids_moved: ext, lookup_jobs_moved: jobs, review_rows_moved: review,
    };
    this.pushChange(state, { editionId: keepId, actor: actor || 'system', reason, before: { merged_edition: before as unknown as Record<string, unknown> }, after: { merged_into: keepId, ...summary } });
    delete state.editions[dropId];
    await this.save();
    return summary;
  }
}

type Table = 'job' | 'event' | 'import' | 'share';

// ---------------------------------------------------------------------------
// Canonical artist change helpers (migration 0037, file store). "Images" are the same rows the SQL functions
// compare: normalized so that the planner's images and the stored rows line up. Performance rows have no ID
// here (EditionPerformance has none), so they match by edition and artist key, and no ID is made up.
// ---------------------------------------------------------------------------

type Side = 'before' | 'after';
type ImageSection = 'artists' | 'performances' | 'aliases' | 'owner' | 'ownerAliases' | 'ownerLinks' | 'events';
type Images = Record<ImageSection, unknown[]>;
type Canonical = SqlCanonicalEntry['canonical'];

const OPERATIONS: readonly string[] = CANONICAL_OPERATIONS;

function assertCanonicalEntry(entry: SqlCanonicalEntry): void {
  const c = entry?.canonical;
  const sides = c ? [c.artists, c.performances, c.aliases, c.owner, c.ownerAliases, c.ownerLinks, c.events] : [];
  const ok =
    Boolean(entry?.id) &&
    OPERATIONS.includes(entry.operation) &&
    Boolean(c) &&
    typeof c.key === 'string' &&
    Array.isArray(c.ownerTouched) &&
    Array.isArray(c.activity) &&
    sides.every((s) => Array.isArray(s.before) && Array.isArray(s.after));
  if (!ok) throw new CanonicalStoreError('generic', 'The change has no id, a known operation, or a canonical block.');
}

const VOCAB_OPERATIONS = new Set<string>(['rename', 'alias-add', 'alias-remove', 'merge', 'parent', 'umbrella-add', 'umbrella-remove', 'spelling', 'create', 'undo',
  'taxonomy-import', 'relations-import', 'relation-add', 'relation-remove', 'relation-weight', 'family']);

// The taxonomy fields a stored genre keeps: a level other than 'genre', its primary parent, tier and links.
function taxonomyOf(g: Partial<VocabGenre>): Partial<Pick<VocabGenre, 'level' | 'primaryParent' | 'tier' | 'relations'>> {
  return {
    ...(g.level && g.level !== 'genre' ? { level: g.level } : {}),
    ...(g.primaryParent ? { primaryParent: g.primaryParent } : {}),
    ...(g.tier ? { tier: g.tier } : {}),
    ...(g.relations?.length ? { relations: relationsOf(g) } : {}),
  };
}

// Outgoing links as genre_relations lists them: by target, then type.
function relationsOf(g: Partial<VocabGenre>): NonNullable<VocabGenre['relations']> {
  return (g.relations ?? [])
    .map((r) => ({ target: r.target, type: r.type, weight: r.weight, origin: r.origin }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

// genre_vocabulary_images (0060): the given genres as they are now, ordered by key; a key with no genre is left out.
// forLog: log images always carry level and relations, as genre_vocabulary_images does, so an
// undo replaces the taxonomy instead of keeping what is there now.
function vocabImages(vocab: Record<string, VocabGenre>, keys: string[], forLog = false): VocabGenre[] {
  return [...new Set(keys)]
    .filter((k) => has(vocab, k))
    .sort()
    .map((k) => {
      const g = vocab[k];
      return {
        key: g.key,
        name: g.name,
        ...(g.parent ? { parent: g.parent } : {}),
        ...taxonomyOf(g),
        ...(forLog ? { level: g.level ?? 'genre', relations: relationsOf(g) } : {}),
        aliases: [...g.aliases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((a) => ({ key: a.key, alias: a.alias })),
        umbrellas: [...g.umbrellas].sort(),
      };
    });
}

function ownerOnly(scope: UserScope): void {
  if (scope.role !== 'owner') throw new CanonicalStoreError('forbidden', 'Only the owner can do this.');
}

const has = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);
const lookup = <T>(map: Record<string, T> | undefined, key: string): T | undefined => (map && has(map, key) ? map[key] : undefined);

// Stable JSON: keys sorted, undefined read as null, so equal rows give equal text.
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeys(obj[k])]));
  }
  return value === undefined ? null : value;
}

const nArtist = (a: SqlArtistImage) => ({ key: a.key, name: a.name, mbid: a.mbid ?? null, resolved_at: a.resolved_at ?? null });
const nPerf = (p: SqlPerformanceImage) => ({
  id: p.id ?? null,
  edition_id: p.edition_id,
  artist_key: p.artist_key,
  name: p.name,
  days: p.days ?? [],
  stages: p.stages ?? [],
  status: p.status,
  billing: p.billing ?? null,
  confidence: Number(p.confidence),
  sources: p.sources ?? [],
  slot_id: p.slot_id ?? null,
  alias: p.alias ?? null,
  b2b: p.b2b?.length ? p.b2b : null,
  set: p.set ?? null,
});
const nAlias = (a: ArtistAliasRow) => ({ alias: a.alias, name: a.name });
const nEntity = (e: SqlEntityImage) => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  name_normalized: e.name_normalized,
  attrs: e.attrs ?? {},
  merged_into_id: e.merged_into_id ?? null,
});
const nOwnerAlias = (a: SqlOwnerAliasImage) => ({ entity_id: a.entity_id, kind: a.kind, alias: a.alias });
// created_at is left out, as in the SQL state comparison.
const nOwnerLink = (l: SqlOwnerLinkImage) => ({ from_id: l.from_id, to_id: l.to_id, role: l.role });
const nEvent = (e: SqlEventSeenImage) => ({ id: e.id, seen: e.seen ?? null });

function planImages(entry: SqlCanonicalEntry, side: Side): Images {
  const c = entry.canonical;
  return {
    artists: c.artists[side].map(nArtist),
    performances: c.performances[side].map(nPerf),
    aliases: c.aliases[side].map(nAlias),
    owner: c.owner[side].map(nEntity),
    ownerAliases: c.ownerAliases[side].map(nOwnerAlias),
    ownerLinks: c.ownerLinks[side].map(nOwnerLink),
    events: c.events[side].map(nEvent),
  };
}

// The current rows of everything the change touches (the SQL "db" state).
function currentImages(state: FileState, entry: SqlCanonicalEntry): Images {
  const c = entry.canonical;
  const keys = new Set<string>([c.key, ...c.artists.before.map((a) => a.key), ...c.artists.after.map((a) => a.key)]);
  const ownerIds = new Set<string>([...c.owner.before, ...c.owner.after].map((e) => e.id));
  const touched = new Set<string>(c.ownerTouched);
  const aliasKeys = [...c.aliases.before, ...c.aliases.after].map((a) => a.alias);
  const eventIds = [...c.events.before, ...c.events.after].map((e) => e.id);
  const editions = Object.values(state.editions);
  return {
    artists: Object.values(state.artists)
      .filter((a) => keys.has(a.key))
      .map((a) => nArtist({ key: a.key, name: a.name, mbid: a.mbid ?? null, resolved_at: a.resolvedAt ?? null })),
    performances: editions.flatMap((ed) =>
      ed.performances.filter((p) => keys.has(p.artistKey)).map((p) => nPerf(performanceImage(ed.id, p))),
    ),
    aliases: aliasKeys.flatMap((alias) => (has(state.aliases, alias) ? [nAlias({ alias, name: state.aliases[alias] })] : [])),
    owner: Object.values(state.entities ?? {})
      .filter((e) => e.kind === 'artist' && (ownerIds.has(e.id) || keys.has(e.nameNormalized)))
      .map((e) => nEntity(entityImage(e))),
    ownerAliases: (state.entityAliases ?? [])
      .filter((a) => touched.has(a.entityId))
      .map((a) => nOwnerAlias({ entity_id: a.entityId, kind: a.kind, alias: a.aliasNormalized })),
    ownerLinks: (state.entityLinks ?? [])
      .filter((l) => touched.has(l.fromId) || touched.has(l.toId))
      .map((l) => nOwnerLink({ from_id: l.fromId, to_id: l.toId, role: l.role, created_at: l.createdAt })),
    events: eventIds.flatMap((id) => (lookup(state.events, id) ? [nEvent({ id, seen: state.events[id].seen })] : [])),
  };
}

// The comparison text: each section as sorted row texts, so row order does not matter.
function keyOf(images: Images): string {
  return stableJson(Object.fromEntries(Object.entries(images).map(([section, rows]) => [section, (rows as unknown[]).map(stableJson).sort()])));
}

function fingerprintOf(images: Images): string {
  return createHash('md5').update(keyOf(images)).digest('hex');
}

function performanceImage(editionId: string, p: EditionPerformance): SqlPerformanceImage {
  return {
    id: null,
    edition_id: editionId,
    artist_key: p.artistKey,
    name: p.name,
    days: p.days,
    stages: p.stages,
    status: p.status,
    billing: p.billing ?? null,
    confidence: p.confidence,
    sources: p.sources,
    slot_id: p.slotId ?? null,
    alias: p.alias ?? null,
    b2b: p.b2b ?? null,
    set: p.set ?? null,
  };
}

function entityImage(e: Entity): SqlEntityImage {
  return { id: e.id, kind: e.kind, name: e.name, name_normalized: e.nameNormalized, attrs: e.attrs, merged_into_id: e.mergedIntoId ?? null };
}

// Refuses the write before anything changes: the "to" side must point at rows that exist.
function checkWritable(state: FileState, c: Canonical, to: Side): void {
  if (c.owner[to].some((e) => !lookup(state.entities, e.id)) || c.events[to].some((e) => !lookup(state.events, e.id))) {
    throw new CanonicalStoreError('stale', 'Preview is out of date; review it again');
  }
  if (c.performances[to].some((p) => !lookup(state.editions, p.edition_id))) {
    throw new CanonicalStoreError('generic', 'A performance points at an edition that does not exist.');
  }
}

// Writes the "to" side over the "from" side, in the SQL order: remove the from rows, insert the to rows,
// update owner records in place, replace the touched owner aliases and links, then rewrite the seen text.
function writeSide(state: FileState, c: Canonical, from: Side, to: Side, at: string): void {
  for (const a of c.artists[from]) delete state.artists[a.key];
  for (const a of c.artists[to]) {
    state.artists[a.key] = {
      key: a.key,
      name: a.name,
      ...(a.mbid != null ? { mbid: a.mbid } : {}),
      ...(a.resolved_at != null ? { resolvedAt: a.resolved_at } : {}),
    };
  }

  // A row keeps the fields the image does not carry (mbid, oneAct) when a row in the same edition is replaced.
  const removed: Array<{ editionId: string; row: EditionPerformance; used: boolean }> = [];
  for (const p of c.performances[from]) {
    const edition = lookup(state.editions, p.edition_id);
    const at = edition ? edition.performances.findIndex((x) => x.artistKey === p.artist_key) : -1;
    if (edition && at >= 0) removed.push({ editionId: p.edition_id, row: edition.performances.splice(at, 1)[0], used: false });
  }
  for (const p of c.performances[to]) {
    const pick =
      removed.find((r) => !r.used && r.editionId === p.edition_id && r.row.artistKey === p.artist_key) ??
      removed.find((r) => !r.used && r.editionId === p.edition_id);
    if (pick) pick.used = true;
    state.editions[p.edition_id].performances.push({ ...(pick?.row ?? {}), ...performanceOf(p) } as EditionPerformance);
  }

  for (const a of c.aliases[from]) delete state.aliases[a.alias];
  for (const a of c.aliases[to]) state.aliases[a.alias] = a.name;

  for (const e of c.owner[to]) {
    const cur = state.entities![e.id];
    cur.kind = e.kind as Entity['kind'];
    cur.name = e.name;
    cur.nameNormalized = e.name_normalized;
    cur.attrs = e.attrs;
    if (e.merged_into_id) cur.mergedIntoId = e.merged_into_id;
    else delete cur.mergedIntoId;
  }

  const touched = new Set<string>(c.ownerTouched);
  state.entityAliases = [
    ...(state.entityAliases ?? []).filter((a) => !touched.has(a.entityId)),
    ...c.ownerAliases[to].map((a) => ({ entityId: a.entity_id, kind: a.kind as EntityAlias['kind'], aliasNormalized: a.alias })),
  ];
  state.entityLinks = [
    ...(state.entityLinks ?? []).filter((l) => !touched.has(l.fromId) && !touched.has(l.toId)),
    ...c.ownerLinks[to].map((l) => ({
      fromId: l.from_id,
      toId: l.to_id,
      role: l.role as EntityLink['role'],
      createdAt: l.created_at ?? at,
    })),
  ];

  for (const ev of c.events[to]) state.events[ev.id].seen = ev.seen as LoggedEvent['seen'];
}

function performanceOf(p: SqlPerformanceImage): EditionPerformance {
  return {
    artistKey: p.artist_key,
    name: p.name,
    days: p.days,
    stages: p.stages,
    status: p.status,
    billing: (p.billing ?? undefined) as EditionPerformance['billing'],
    confidence: p.confidence,
    sources: p.sources as EditionPerformance['sources'],
    slotId: p.slot_id ?? undefined,
    alias: p.alias ?? undefined,
    b2b: p.b2b?.length ? p.b2b : undefined,
    set: p.set ?? undefined,
  };
}

// Seen-text activity for an Undo: the text before the Undo ("after" side) and the restored text, per changed event.
function undoActivity(c: Canonical): SqlActivityRow[] {
  const before = new Map(c.events.before.map((e) => [e.id, e.seen] as const));
  return c.events.after.flatMap((a) => {
    if (!before.has(a.id)) return [];
    const restored = before.get(a.id);
    if (stableJson(a.seen) === stableJson(restored)) return [];
    return [{ event_id: a.id, action: 'update' as const, field: 'seen', before: a.seen, after: restored, sensitive: false }];
  });
}

function pushActivity(state: FileState, rows: SqlActivityRow[], at: string): void {
  const log = (state.activity ??= []);
  rows.forEach((row, i) =>
    log.push({
      id: `${at}-${log.length}-${i}`,
      eventId: row.event_id,
      action: row.action,
      field: row.field,
      before: row.before,
      after: row.after,
      sensitive: row.sensitive,
      at,
      userId: null,
    }),
  );
}

// One member's view of the file store, behaving like the Supabase store
// with row level security: other members' rows are invisible, and writing
// over one is refused (an upsert that hits another member's id fails).
function scopedFileStore(base: FileLineupStore, scope: UserScope): LineupStore {
  const mine = async (table: Table, id: string) => {
    const owner = (await base.ownersState()).owners[`${table}:${id}`];
    return owner ? owner === scope.userId : scope.role === 'owner';
  };
  const claim = async (table: Table, ids: string[]) => {
    const { owners } = await base.ownersState();
    for (const id of ids) {
      const owner = owners[`${table}:${id}`];
      if (owner ? owner !== scope.userId : scope.role !== 'owner' && (await exists(table, id))) {
        throw new Error(`File ${table} write refused: row ${id} belongs to another member.`);
      }
    }
    for (const id of ids) owners[`${table}:${id}`] = scope.userId;
  };
  const exists = async (table: Table, id: string) =>
    table === 'job' ? Boolean(await base.getJob(id)) : table === 'event' ? Boolean(await base.getEvent(id)) : table === 'import' ? (await base.listImports()).some((r) => r.id === id) : (await base.listShareLinks()).some((l) => l.id === id);
  const keep = async <T extends { id: string }>(table: Table, rows: T[]) => {
    const out: T[] = [];
    for (const r of rows) if (await mine(table, r.id)) out.push(r);
    return out;
  };
  const overrides: Partial<LineupStore> = {
    // Canonical artist changes are owner only (migration 0037 checks the owner inside each function).
    async canonicalArtistFingerprint(entry) {
      ownerOnly(scope);
      return base.canonicalArtistFingerprint(entry);
    },
    async applyCanonicalArtistChange(entry, fingerprint) {
      ownerOnly(scope);
      return base.applyCanonicalArtistChange(entry, fingerprint);
    },
    async undoCanonicalArtistChange(historyId) {
      ownerOnly(scope);
      return base.undoCanonicalArtistChange(historyId);
    },
    async listCanonicalHistoryPage(options) {
      ownerOnly(scope);
      return base.listCanonicalHistoryPage(options);
    },
    async createJob(job) {
      await claim('job', [job.id]);
      await base.createJob({ ...job, userId: scope.userId });
    },
    async updateJob(job) {
      await claim('job', [job.id]);
      await base.updateJob({ ...job, userId: scope.userId });
    },
    async getJob(id) {
      return (await mine('job', id)) ? base.getJob(id) : null;
    },
    async listJobs(limit) {
      return (await keep('job', await base.listJobs(Number.MAX_SAFE_INTEGER))).slice(0, limit);
    },
    async listCanonicalJobs(limit) {
      return (await keep('job', await base.listCanonicalJobs(Number.MAX_SAFE_INTEGER))).slice(0, limit);
    },
    async getJobs(ids) {
      return keep('job', await base.getJobs(ids));
    },
    async putEvent(event) {
      await claim('event', [event.id]);
      await base.putEventsFor(scope.userId, [event]);
    },
    async putEvents(events) {
      await claim('event', events.map((e) => e.id));
      await base.putEventsFor(scope.userId, events);
    },
    // A member reads the shared genres plus their own additions (source 'added'), and writes only those.
    // Shared writes, the change log and the seen-act list are owner and system only.
    ...(scope.role === 'owner'
      ? {
          runArtistCleanup: (rows: ArtistCleanupRow[], opts: { dryRun: boolean; actor: string; reason: string }) =>
            base.runArtistCleanup(rows, opts, scope.userId),
        }
      : {
          async listArtistGenres() {
            const own = Object.values(await base.memberGenres(scope.userId)).map((r): ArtistGenres => ({ ...clone(r), source: 'added' }));
            return [...(await base.listArtistGenres()), ...own];
          },
          async putArtistGenres(rows: ArtistGenres[]) {
            // 'you' is still accepted from callers that have not moved to 'added'.
            if (rows.some((r) => r.source !== 'added' && r.source !== 'you')) throw new Error('A member can only keep genres they set themselves.');
            const own = await base.memberGenres(scope.userId);
            for (const r of rows) own[r.key] = { ...clone(r), source: 'added' };
            await base.saveMemberGenres();
          },
          async deleteArtistGenres(key: string, source: ArtistGenres['source']) {
            if (source !== 'added' && source !== 'you') return;
            delete (await base.memberGenres(scope.userId))[key];
            await base.saveMemberGenres();
          },
          async writeArtistGenres() {
            ownerOnly(scope);
            return [];
          },
          async listGenreChanges() {
            ownerOnly(scope);
            return [];
          },
          async markGenreChangesUndone() {
            ownerOnly(scope);
          },
          async listSeenActNames() {
            ownerOnly(scope);
            return [];
          },
          async runArtistCleanup() {
            ownerOnly(scope);
            return {
              dryRun: true,
              counts: emptyStatusCounts(),
              totalRows: 0,
              performancesMigrated: 0,
              performancesDeduped: 0,
              newArtistsInserted: 0,
              parentStubsInserted: 0,
              ownerEventsUpdated: 0,
              failedResolutions: [],
              assertions: { remainingDeprecatedActive: 0, orphanedPerformances: 0, missingBlocklistEntries: 0 },
            };
          },
          async writeGenreVocabulary(): Promise<GenreVocabChange> {
            ownerOnly(scope);
            throw new Error('unreachable');
          },
          async listGenreVocabChanges() {
            ownerOnly(scope);
            return [];
          },
          async markGenreVocabChangesUndone() {
            ownerOnly(scope);
          },
        }),
    // Each member has their own records (user_entities and friends in Supabase).
    listEntities: () => base.listEntitiesFor(scope.userId),
    addEntities: (list) => base.addEntitiesFor(scope.userId, list),
    listEntityAliases: () => base.listEntityAliasesFor(scope.userId),
    addEntityAliases: (list) => base.addEntityAliasesFor(scope.userId, list),
    listEntityLinks: () => base.listEntityLinksFor(scope.userId),
    addEntityLinks: (list) => base.addEntityLinksFor(scope.userId, list),
    putEntities: (list) => base.putEntitiesFor(scope.userId, list),
    replaceEntityAliases: (ids, list) => base.replaceEntityAliasesFor(scope.userId, ids, list),
    replaceEntityLinks: (ids, list) => base.replaceEntityLinksFor(scope.userId, ids, list),
    deleteEntities: (ids) => base.deleteEntitiesFor(scope.userId, ids),
    deleteEntityHistory: (ids) => base.deleteEntityHistoryFor(scope.userId, ids),
    putEntityHistory: (entry) => base.putEntityHistoryFor(scope.userId, entry),
    getEntityHistory: (id) => base.getEntityHistoryFor(scope.userId, id),
    listEntityHistory: (limit) => base.listEntityHistoryFor(scope.userId, limit),
    async getEvent(id) {
      return (await mine('event', id)) ? base.getEvent(id) : null;
    },
    async listEvents() {
      return keep('event', await base.listEvents());
    },
    listSeenArtistNames: async () => {
      const myEvents = await keep('event', await base.listEvents());
      return myEvents
        .filter((e) => !e.deletedAt)
        .flatMap((e) => (e.seen ?? []).map((a) => a?.name).filter((n): n is string => typeof n === 'string' && Boolean(n.trim())).map((n) => n.trim()));
    },
    async deleteEvent(id) {
      if (await mine('event', id)) await base.deleteEventFor(scope.userId, id);
    },
    async restoreEvent(id) {
      return (await mine('event', id)) ? base.restoreEventFor(scope.userId, id) : false;
    },
    async eraseDeletedEvent(id) {
      return (await mine('event', id)) ? base.eraseDeletedEventFor(scope.userId, id) : false;
    },
    async emptyTrash() {
      const ids = (await base.listDeletedEvents()).map((e) => e.id);
      let removed = 0;
      for (const id of ids) if ((await mine('event', id)) && (await base.eraseDeletedEventFor(scope.userId, id))) removed++;
      return removed;
    },
    async listDeletedEvents() {
      return keep('event', await base.listDeletedEvents());
    },
    // Only the nightly job purges, across every member. A member's own scope never erases anyone's trash.
    async purgeDeletedEvents() {
      return 0;
    },
    async listActivity(limit) {
      return base.listActivityFor(scope.userId, limit);
    },
    async purgeActivity() {
      return 0;
    },
    async listImports() {
      return keep('import', await base.listImports());
    },
    async putImports(rows) {
      await claim('import', rows.map((r) => r.id));
      await base.putImports(rows);
    },
    async listShareLinks() {
      return keep('share', await base.listShareLinks());
    },
    async getShareLinkByHash(codeHash) {
      const link = await base.getShareLinkByHash(codeHash);
      return link && (await mine('share', link.id)) ? link : null;
    },
    async putShareLink(link) {
      await claim('share', [link.id]);
      await base.putShareLink({ ...link, userId: scope.userId });
    },
    async listShareEvents() {
      const ids = new Set((await keep('event', await base.listEvents())).map((e) => e.id));
      return (await base.listShareEvents()).filter((e) => ids.has(e.id));
    },
    async getSetting<T>(key: string) {
      const own = (await base.ownersState()).userSettings[scope.userId]?.[key];
      if (own !== undefined) return clone(own as T);
      return scope.role === 'owner' ? base.getSetting<T>(key) : null;
    },
    async putSetting<T>(key: string, data: T) {
      const { userSettings } = await base.ownersState();
      userSettings[scope.userId] = { ...userSettings[scope.userId], [key]: clone(data) };
      await base.saveOwners();
    },
    forUser(next) {
      return scopedFileStore(base, next);
    },
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in overrides) return (overrides as any)[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as LineupStore;
}
