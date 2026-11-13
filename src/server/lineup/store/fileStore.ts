import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
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
import { splitEventCity } from '../../events/regions';
import { LineupFacts, lineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';
import type { ArtistGenres } from '../../events/genres';
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
import type { AiCallRow, MergeSummary } from './types';
import type { CanonicalVenue, EditionChange, ReviewQueueItem, ReviewQueueKind, VenueAlias, EditionExternalId } from '../types';
import { assertNoPersonalFields, ExternalIdConflictError, venueIdFor } from './types';
import { normalizeName } from '../normalizeName';
import type { CachedResponse } from '../responseCache';
import {
  canonicalEditionPage,
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
  venues?: Record<string, CanonicalVenue>;
  venueAliases?: Array<VenueAlias>;
  editionExternalIds?: EditionExternalId[];
  editionChanges?: EditionChange[];
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

  async getSeries(slug: string) {
    const s = (await this.load()).series[slug];
    return s ? clone(s) : null;
  }

  async upsertSeries(series: SeriesRecord) {
    (await this.load()).series[series.slug] = clone(series);
    await this.save();
  }

  async getEditionByKey(key: string) {
    const ed = Object.values((await this.load()).editions).find((e) => e.key === key);
    return ed ? clone(ed) : null;
  }

  async getEdition(id: string) {
    const ed = (await this.load()).editions[id];
    return ed ? clone(ed) : null;
  }
  async getEditions(ids: string[]) {
    const editions = (await this.load()).editions;
    return clone(ids.map((id) => editions[id]).filter((e): e is Edition => Boolean(e)));
  }


  async upsertEdition(edition: Edition) {
    (await this.load()).editions[edition.id] = clone(edition);
    await this.save();
  }

  async editionLineupFacts(ids: string[]) {
    const editions = (await this.load()).editions;
    const out: Record<string, LineupFacts> = {};
    for (const id of ids) out[id] = lineupFacts(editions[id] ?? { performances: [] });
    return out;
  }

  async listEditions(limit: number) {
    const eds = Object.values((await this.load()).editions);
    return clone(eds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit));
  }

  async suggestEditions(query: string, opts: { excludeIds: string[]; limit: number }) {
    return suggestEditionMatches(Object.values((await this.load()).editions), query, opts);
  }

  async listCanonicalEditionsPage(options: CanonicalEditionPageOptions) {
    const eds = Object.values((await this.load()).editions);
    return clone(canonicalEditionPage(eds, options));
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
      // A save never undeletes a show: deletedAt is only changed by delete and restore.
      state.events[e.id] = clone({ ...splitEventCity(e), deletedAt: prior?.deletedAt });
      this.logActivity(state, uid, diffEvent(prior ? splitEventCity(prior) : null, splitEventCity(e), isCiphertext), now);
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

  async getArtist(key: string) {
    const a = (await this.load()).artists[key];
    return a ? clone(a) : null;
  }

  async getArtists(keys: string[]) {
    const { artists } = await this.load();
    return clone(keys.map((k) => artists[k]).filter((a): a is ArtistIdentity => Boolean(a)));
  }

  async upsertArtist(artist: ArtistIdentity) {
    (await this.load()).artists[artist.key] = clone(artist);
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

  // Owner's canonical history (slice 8.9). Two sources, merged by id: entityHistory rows with a canonical operation,
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
    if (existing) return clone(existing);
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

  async addReviewItem(i: { kind: ReviewQueueKind; editionId?: string; eventId?: string; payload: Record<string, unknown> }) {
    assertNoPersonalFields(i.payload);
    const state = await this.load();
    const row: ReviewQueueItem = { id: crypto.randomUUID(), kind: i.kind, editionId: i.editionId, eventId: i.eventId, payload: clone(i.payload), status: 'open', createdAt: new Date().toISOString() };
    (state.reviewQueue ??= []).push(row);
    await this.save();
    return clone(row);
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
    // A member's genres are their own; the owner's shared ones come from the music-story export.
    ...(scope.role === 'owner'
      ? {}
      : {
          async listArtistGenres() {
            return clone(Object.values(await base.memberGenres(scope.userId)));
          },
          async putArtistGenres(rows: ArtistGenres[]) {
            if (rows.some((r) => r.source !== 'you')) throw new Error('A member can only keep genres they set themselves.');
            const own = await base.memberGenres(scope.userId);
            for (const r of rows) own[r.key] = clone(r);
            await base.saveMemberGenres();
          },
          async deleteArtistGenres(key: string, source: ArtistGenres['source']) {
            if (source !== 'you') return;
            delete (await base.memberGenres(scope.userId))[key];
            await base.saveMemberGenres();
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
