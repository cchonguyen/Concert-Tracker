import { promises as fs } from 'node:fs';
import path from 'node:path';
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
import { splitEventCity } from '../../events/regions';
import { LineupFacts, lineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';
import type { ArtistGenres } from '../../events/genres';
import { Entity, EntityAlias, EntityLink, HistoryEntry } from '../../entities/types';
import { checkAliases, checkEntities, checkEventRefs, checkLinks } from '../../entities/integrity';
import { isStaleRun, LineupStore, MAX_EXAMPLES_PER_DOMAIN, STALE_RUN_MS } from './types';

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

  constructor(private readonly dir: string) {}

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
    return clone(jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit));
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
    const state = await this.load();
    // The foreign keys Supabase has on venue_id, place_id and series_id,
    // plus the IDs inside companions and seen that it cannot check.
    const entities = new Map(Object.entries(state.entities ?? {}));
    for (const e of events) checkEventRefs(entities, e);
    for (const e of events) state.events[e.id] = clone(splitEventCity(e));
    await this.save();
  }

  async getEvent(id: string) {
    const ev = (await this.load()).events[id];
    return ev ? clone(splitEventCity(ev)) : null;
  }

  async listEvents() {
    return clone(Object.values((await this.load()).events).map((e) => splitEventCity(e)));
  }

  async deleteEvent(id: string) {
    delete (await this.load()).events[id];
    await this.save();
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

  async listUnresolvedArtists(limit: number) {
    return clone(
      Object.values((await this.load()).artists)
        .filter((a) => !a.resolvedAt)
        .slice(0, limit),
    );
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

  async listEntities() {
    return clone(Object.values((await this.load()).entities ?? {}));
  }

  async addEntities(entities: Entity[]) {
    const state = await this.load();
    const all = new Map(Object.entries(state.entities ?? {}));
    const fresh = [...new Map(entities.filter((e) => !all.has(e.id)).map((e) => [e.id, e])).values()];
    checkEntities(all, fresh);
    state.entities = { ...state.entities };
    for (const e of fresh) state.entities[e.id] = clone(e);
    await this.save();
  }

  async listEntityAliases() {
    return clone((await this.load()).entityAliases ?? []);
  }

  async addEntityAliases(aliases: EntityAlias[]) {
    const state = await this.load();
    const existing = state.entityAliases ?? [];
    const held = new Set(existing.map((a) => `${a.kind}\u0000${a.aliasNormalized}\u0000${a.entityId}`));
    const fresh = aliases.filter((a) => !held.has(`${a.kind}\u0000${a.aliasNormalized}\u0000${a.entityId}`));
    checkAliases(new Map(Object.entries(state.entities ?? {})), existing, fresh);
    const seen = new Set<string>();
    state.entityAliases = [
      ...existing,
      ...fresh.filter((a) => {
        const k = `${a.kind}\u0000${a.aliasNormalized}`;
        return !seen.has(k) && seen.add(k);
      }).map(clone),
    ];
    await this.save();
  }

  async listEntityLinks() {
    return clone((await this.load()).entityLinks ?? []);
  }

  async addEntityLinks(links: EntityLink[]) {
    const state = await this.load();
    const existing = state.entityLinks ?? [];
    const pk = (l: EntityLink) => `${l.fromId}\u0000${l.toId}\u0000${l.role}`;
    const have = new Set(existing.map(pk));
    const fresh = [...new Map(links.filter((l) => !have.has(pk(l))).map((l) => [pk(l), l])).values()];
    checkLinks(new Map(Object.entries(state.entities ?? {})), fresh);
    state.entityLinks = [...existing, ...fresh.map(clone)];
    await this.save();
  }

  async putEntities(entities: Entity[]) {
    const state = await this.load();
    checkEntities(new Map(Object.entries(state.entities ?? {})), entities);
    state.entities = { ...state.entities };
    for (const e of entities) state.entities[e.id] = clone(e);
    await this.save();
  }

  async replaceEntityAliases(entityIds: string[], aliases: EntityAlias[]) {
    const state = await this.load();
    const ids = new Set(entityIds);
    const kept = (state.entityAliases ?? []).filter((a) => !ids.has(a.entityId));
    checkAliases(new Map(Object.entries(state.entities ?? {})), kept, aliases);
    const seen = new Set<string>();
    const fresh = aliases.filter((a) => {
      const k = `${a.kind}\u0000${a.aliasNormalized}`;
      return !seen.has(k) && Boolean(seen.add(k));
    });
    state.entityAliases = [...kept, ...fresh.map(clone)];
    await this.save();
  }

  async replaceEntityLinks(entityIds: string[], links: EntityLink[]) {
    const state = await this.load();
    const ids = new Set(entityIds);
    const kept = (state.entityLinks ?? []).filter((l) => !ids.has(l.fromId) && !ids.has(l.toId));
    checkLinks(new Map(Object.entries(state.entities ?? {})), links);
    const pk = (l: EntityLink) => `${l.fromId}\u0000${l.toId}\u0000${l.role}`;
    const have = new Set(kept.map(pk));
    state.entityLinks = [...kept, ...links.filter((l) => !have.has(pk(l)) && Boolean(have.add(pk(l)))).map(clone)];
    await this.save();
  }

  async putEntityHistory(entry: HistoryEntry) {
    const state = await this.load();
    state.entityHistory = { ...state.entityHistory, [entry.id]: clone(entry) };
    await this.save();
  }

  async getEntityHistory(id: string) {
    const h = (await this.load()).entityHistory?.[id];
    return h ? clone(h) : null;
  }

  async listEntityHistory(limit: number) {
    const all = Object.values((await this.load()).entityHistory ?? {});
    return clone(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }
}
