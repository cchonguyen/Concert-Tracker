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
import { LineupStore, MAX_EXAMPLES_PER_DOMAIN } from './types';

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
  artists: Record<string, ArtistIdentity>;
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
        (j.status === 'queued' || j.status === 'waiting_quota') &&
        (!j.nextAttemptAt || j.nextAttemptAt <= iso),
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

  async upsertEdition(edition: Edition) {
    (await this.load()).editions[edition.id] = clone(edition);
    await this.save();
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

  async putAlias(normalizedAlias: string, canonicalName: string) {
    (await this.load()).aliases[normalizedAlias] = canonicalName;
    await this.save();
  }

  async getBlocklist(domains: string[]) {
    return clone((await this.load()).blocklist.filter((b) => domains.includes(b.domain)));
  }

  async bumpBlocklist(domain: string, normalized: string) {
    const state = await this.load();
    const entry = state.blocklist.find((b) => b.domain === domain && b.normalized === normalized);
    if (entry) entry.rejections += 1;
    else state.blocklist.push({ domain, normalized, rejections: 1 });
    await this.save();
  }

  async getSourceStats() {
    return clone((await this.load()).sourceStats);
  }

  async bumpSourceStat(sourceType: SourceType, scope: string, accepted: boolean) {
    const state = await this.load();
    let stat = state.sourceStats.find((s) => s.sourceType === sourceType && s.scope === scope);
    if (!stat) {
      stat = { sourceType, scope, accepted: 0, rejected: 0 };
      state.sourceStats.push(stat);
    }
    if (accepted) stat.accepted += 1;
    else stat.rejected += 1;
    await this.save();
  }

  async addCorrection(correction: Correction) {
    (await this.load()).corrections.push(clone(correction));
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
    (await this.load()).events[event.id] = clone(event);
    await this.save();
  }

  async getEvent(id: string) {
    const ev = (await this.load()).events[id];
    return ev ? clone(ev) : null;
  }

  async listEvents() {
    return clone(Object.values((await this.load()).events));
  }

  async deleteEvent(id: string) {
    delete (await this.load()).events[id];
    await this.save();
  }

  async getArtist(key: string) {
    const a = (await this.load()).artists[key];
    return a ? clone(a) : null;
  }

  async upsertArtist(artist: ArtistIdentity) {
    (await this.load()).artists[artist.key] = clone(artist);
    await this.save();
  }

  async listUnresolvedArtists(limit: number) {
    return clone(
      Object.values((await this.load()).artists)
        .filter((a) => !a.resolvedAt)
        .slice(0, limit),
    );
  }
}
