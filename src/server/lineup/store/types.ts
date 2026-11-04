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
import type { ActivityEntry } from '../../events/activityLog';
import type { LineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';
import type { ArtistGenres } from '../../events/genres';
import { ArtistEditionRow, Entity, EntityAlias, EntityLink, HistoryEntry } from '../../entities/types';
import type { ShareLink } from '../../share/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CachedResponse } from '../responseCache';

// One member's view of the store (multi-user mode). Personal rows (events,
// email imports, lookup jobs, share links, settings) are that member's only.
// db: a Supabase client carrying the member's short-lived token, so row level
// security also applies; left out by the system paths (queue, share page),
// which filter by userId with the service key.
export interface UserScope {
  userId: string;
  role: 'owner' | 'member';
  db?: SupabaseClient;
}

export type CanonicalEditionStatusFilter = 'all' | Edition['status'];

export interface CanonicalEditionPageOptions {
  query?: string;
  status?: CanonicalEditionStatusFilter;
  limit: number;
}

export interface CanonicalEditionPage<T = Edition> {
  editions: T[];
  total: number;
  hasMore: boolean;
}

export type CanonicalEditionListRow = Pick<Edition, 'id' | 'seriesSlug' | 'year' | 'name' | 'venue' | 'status'>;

// Keep filtering and the visible order identical in both stores. Filter the
// full catalog before slicing so an older matching edition remains findable.
export function canonicalEditionPage<T extends CanonicalEditionListRow>(
  rows: T[],
  options: CanonicalEditionPageOptions,
): CanonicalEditionPage<T> {
  const query = (options.query ?? '').trim().toLowerCase();
  const status = options.status ?? 'all';
  const matching = rows
    .filter((edition) => status === 'all' || edition.status === status)
    .filter((edition) => !query || [edition.name, edition.seriesSlug, edition.venue ?? ''].some((value) => value.toLowerCase().includes(query)))
    .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const limit = Math.max(0, Math.min(200, Math.floor(options.limit)));
  const editions = matching.slice(0, limit);
  return { editions, total: matching.length, hasMore: matching.length > editions.length };
}

// Persistence boundary for the lineup pipeline. Two implementations:
// fileStore (local dev, no setup) and supabaseStore (durable, used when
// SUPABASE_URL is configured). Both must behave identically.
export interface LineupStore {
  readonly kind: 'file' | 'supabase';

  // Raw upstream responses kept 24 hours (responseCache.ts); only for hosts whose terms allow it.
  getCachedResponse?(key: string, now: Date): Promise<CachedResponse | null>;
  putCachedResponse?(entry: CachedResponse): Promise<void>;

  // The owner's user id (multi-user mode), for the owner's quota reserve.
  ownerUserId?(): Promise<string | null>;

  // The same store limited to one member's personal rows (see UserScope).
  forUser?(scope: UserScope): LineupStore;

  createJob(job: LookupJob): Promise<void>;
  getJob(id: string): Promise<LookupJob | null>;
  updateJob(job: LookupJob): Promise<void>;
  listJobs(limit: number): Promise<LookupJob[]>;
  // Jobs with no saved event (the owner's canonical ingest), newest first.
  listCanonicalJobs(limit: number): Promise<LookupJob[]>;
  getJobs(ids: string[]): Promise<LookupJob[]>;
  // Queued or waiting jobs whose nextAttemptAt (if any) has passed.
  dueJobs(now: Date, limit: number): Promise<LookupJob[]>;

  // Deduplicates on (url, contentHash) and returns the stored document.
  putDocument(doc: SourceDocument): Promise<SourceDocument>;
  getDocument(id: string): Promise<SourceDocument | null>;

  addPerformerClaims(claims: PerformerClaim[]): Promise<void>;
  listPerformerClaims(jobId: string): Promise<PerformerClaim[]>;
  // Claims an earlier job for the same edition took from this document with
  // this extractor and prompt version (the extraction cache).
  findExtractedClaims(q: { editionKey: string; documentId: string; extractor: string; extractorVersion: string; excludeJobId: string }): Promise<PerformerClaim[]>;

  getSeries(slug: string): Promise<SeriesRecord | null>;
  upsertSeries(series: SeriesRecord): Promise<void>;

  getEditionByKey(key: string): Promise<Edition | null>;
  getEdition(id: string): Promise<Edition | null>;
  getEditions(ids: string[]): Promise<Edition[]>;
  upsertEdition(edition: Edition): Promise<void>;
  listEditions(limit: number): Promise<Edition[]>;
  // The Global Archive: filters and counts the full catalog before returning
  // at most 200 editions in year-descending/name-ascending order.
  listCanonicalEditionsPage(options: CanonicalEditionPageOptions): Promise<CanonicalEditionPage>;
  // Size of each confirmed lineup, by edition id, for Concert or Festival.
  editionLineupFacts(ids: string[]): Promise<Record<string, LineupFacts>>;

  getQuota(key: string): Promise<QuotaUsage | null>;
  setQuota(usage: QuotaUsage): Promise<void>;

  // Normalized alias -> canonical display name.
  getAliases(): Promise<Record<string, string>>;
  putAliases(aliases: Record<string, string>): Promise<void>;
  deleteAlias(alias: string): Promise<void>;

  getBlocklist(domains: string[]): Promise<BlocklistEntry[]>;
  // One rejection each; repeats in the list count again.
  bumpBlocklist(entries: Array<{ domain: string; normalized: string }>): Promise<void>;

  getSourceStats(): Promise<SourceStat[]>;
  // Adds each entry's accepted and rejected counts. Writes that grow with a
  // lineup's size take lists, so a confirm stays within a Worker's
  // subrequest limit (Workers Free allows 50 per request).
  bumpSourceStats(deltas: SourceStat[]): Promise<void>;

  addCorrections(corrections: Correction[]): Promise<void>;

  getExamples(domain: string): Promise<ExtractionExample[]>;
  addExample(example: ExtractionExample): Promise<void>;

  // Your event log (stage 1), separate from canonical editions.
  putEvent(event: LoggedEvent): Promise<void>;
  putEvents(events: LoggedEvent[]): Promise<void>;
  getEvent(id: string): Promise<LoggedEvent | null>;
  listEvents(): Promise<LoggedEvent[]>;
  // Distinct or all artist names you have seen across non-deleted events, for spelling resolution.
  listSeenArtistNames(): Promise<string[]>;
  // Delete moves a show to Recently deleted; restore brings it back; the nightly job purges old trash.
  deleteEvent(id: string): Promise<void>;
  restoreEvent(id: string): Promise<boolean>;
  listDeletedEvents(): Promise<LoggedEvent[]>;
  purgeDeletedEvents(olderThan: string): Promise<number>;
  // Delete permanently: one show in Recently deleted, or all of it. Only trashed rows are touched.
  eraseDeletedEvent(id: string): Promise<boolean>;
  emptyTrash(): Promise<number>;
  purgeActivity(olderThan: string): Promise<number>;
  listActivity(limit: number): Promise<ActivityEntry[]>;

  // Ticket emails waiting for your review (stage 1 from email).
  listImports(): Promise<EmailImport[]>;
  putImports(rows: EmailImport[]): Promise<void>;
  // Small JSON settings by key (app_settings): the Gmail sign-in, how far
  // your mail has been read.
  getSetting<T>(key: string): Promise<T | null>;
  putSetting<T>(key: string, data: T): Promise<void>;

  getArtist(key: string): Promise<ArtistIdentity | null>;
  getArtists(keys: string[]): Promise<ArtistIdentity[]>;
  upsertArtist(artist: ArtistIdentity): Promise<void>;
  // Adds the artists not stored yet; existing ones are left as they are.
  ensureArtists(artists: ArtistIdentity[]): Promise<void>;
  listUnresolvedArtists(limit: number): Promise<ArtistIdentity[]>;
  // Every canonical artist (canonical_artists), for the owner's Global Archive.
  listArtists(): Promise<ArtistIdentity[]>;
  // Removes canonical artists (a merged-away one). Only after its performances moved.
  deleteArtists(keys: string[]): Promise<void>;
  // Performances (edition links) of these artists, each with its edition ID.
  artistPerformances(keys: string[]): Promise<ArtistEditionRow[]>;
  // Writes performances as given, keyed by edition and artist (upsert).
  putArtistPerformances(rows: ArtistEditionRow[]): Promise<void>;
  deleteArtistPerformances(rows: Array<{ editionId: string; artistKey: string }>): Promise<void>;
  // Owner view only: artist name key -> members who have it on a live event. Null where the store cannot count across members.
  communityCounts(): Promise<Map<string, number> | null>;

  // Genres of acts you saw (0013), one row per act and source.
  listArtistGenres(): Promise<ArtistGenres[]>;
  // Replaces the rows with the same act and source.
  putArtistGenres(rows: ArtistGenres[]): Promise<void>;
  deleteArtistGenres(key: string, source: ArtistGenres['source']): Promise<void>;
  // Records with permanent IDs (0014, src/server/entities/). Optional until
  // the Manage tab: createStore only links events when the tables exist.
  // Both stores enforce entities/integrity.ts.
  listEntities(): Promise<Entity[]>;
  // Adds records; an ID already stored is left as it is.
  addEntities(entities: Entity[]): Promise<void>;
  listEntityAliases(): Promise<EntityAlias[]>;
  // Adds aliases; one already held by the same record is left as it is.
  addEntityAliases(aliases: EntityAlias[]): Promise<void>;
  listEntityLinks(): Promise<EntityLink[]>;
  // Adds links; one already stored is left as it is.
  addEntityLinks(links: EntityLink[]): Promise<void>;
  // Writes records as given (renames, merges, undo).
  putEntities(entities: Entity[]): Promise<void>;
  // Replaces every alias of these records with `aliases`.
  replaceEntityAliases(entityIds: string[], aliases: EntityAlias[]): Promise<void>;
  // Replaces every link from or to these records with `links`.
  replaceEntityLinks(entityIds: string[], links: EntityLink[]): Promise<void>;
  // Removes records with their aliases and links. Only a member's own
  // records (a person turned into an encrypted one); the shared tables never delete.
  deleteEntities(ids: string[]): Promise<void>;
  putEntityHistory(entry: HistoryEntry): Promise<void>;
  deleteEntityHistory(ids: string[]): Promise<void>;
  getEntityHistory(id: string): Promise<HistoryEntry | null>;
  // Newest first.
  listEntityHistory(limit: number): Promise<HistoryEntry[]>;

  // Share page links (0015, src/server/share/). Optional: only the share
  // page needs the table.
  listShareLinks(): Promise<ShareLink[]>;
  getShareLinkByHash(codeHash: string): Promise<ShareLink | null>;
  putShareLink(link: ShareLink): Promise<void>;
  // Your events with only the columns the share page reads
  // (SHARE_EVENT_COLUMNS); every other field comes back empty.
  listShareEvents(): Promise<LoggedEvent[]>;
}

export const MAX_EXAMPLES_PER_DOMAIN = 3;

// A job left "running" this long was cut off mid-run (a Worker hit its
// subrequest or CPU limit, or the process died) and may be picked up again.
export const STALE_RUN_MS = 10 * 60_000;
export function isStaleRun(job: LookupJob, now: Date): boolean {
  return job.status === 'running' && Date.parse(job.updatedAt) <= now.getTime() - STALE_RUN_MS;
}

// Due jobs in turn by member, so one member's pile of lookups cannot keep
// everyone else waiting: the oldest job of each member, then the next oldest,
// and so on. Members with the oldest waiting job go first. Jobs with no
// member (single-owner) are one group, so their order is unchanged.
export function roundRobin(jobs: LookupJob[], limit: number): LookupJob[] {
  const groups = new Map<string, LookupJob[]>();
  for (const j of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const g = groups.get(j.userId ?? '') ?? [];
    g.push(j);
    groups.set(j.userId ?? '', g);
  }
  const lists = [...groups.values()];
  const out: LookupJob[] = [];
  for (let round = 0; out.length < limit && lists.some((l) => l.length > round); round++) {
    for (const l of lists) if (l[round] && out.length < limit) out.push(l[round]);
  }
  return out;
}
