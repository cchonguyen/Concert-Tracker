import {
  ArtistIdentity,
  BlocklistEntry,
  Correction,
  CanonicalVenue,
  Edition,
  EditionChange,
  ExtractionExample,
  ReviewQueueItem,
  ReviewQueueKind,
  LookupJob,
  PerformerClaim,
  QuotaUsage,
  SeriesRecord,
  SourceDocument,
  SourceStat,
  SourceType,
} from '../types';
import { LoggedEvent } from '../../events/types';
import { normalizeName } from '../normalizeName';
import type { ActivityEntry } from '../../events/activityLog';
import type { LineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';
import type { ArtistGenres } from '../../events/genres';
import { ArtistEditionRow, CANONICAL_OPERATIONS, Entity, EntityAlias, EntityLink, HistoryEntry } from '../../entities/types';
import type { ShareLink } from '../../share/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CachedResponse } from '../responseCache';
import type { SqlCanonicalEntry } from '../../entities/canonicalManage';

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

// Canonical edition suggestions (slice 9.1). Confirmed editions only. Each typed word must be a word prefix of a
// word in the edition name or series slug. Years typed in the query are not matched; they only rank equal-year
// editions first. Both stores call this so their results agree.
export const EDITION_SUGGEST_MAX_LIMIT = 8;

export interface EditionSuggestion {
  id: string;
  name: string;
  year?: number;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string;
  country?: string;
  actCount: number;
}

// Fewer than two letters in the query returns no suggestions.
export function isEditionSuggestQuery(query: string): boolean {
  return (query.match(/\p{L}/gu) ?? []).length >= 2;
}

const YEAR_WORD = /^\d{4}$/;

// Newest start date first; an edition with no start date sorts after one that has one.
function startDateDesc(a: string | undefined, b: string | undefined): number {
  if (a && b) return b.localeCompare(a);
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function toEditionSuggestion(e: Edition): EditionSuggestion {
  const out: EditionSuggestion = { id: e.id, name: e.name, year: e.year, actCount: e.performances.length };
  if (e.startDate) out.startDate = e.startDate;
  if (e.endDate) out.endDate = e.endDate;
  if (e.venue) out.venue = e.venue;
  if (e.city) out.city = e.city;
  if (e.country) out.country = e.country;
  return out;
}

export function suggestEditionMatches(
  editions: Edition[],
  query: string,
  opts: { excludeIds: string[]; limit: number },
): EditionSuggestion[] {
  if (!isEditionSuggestQuery(query)) return [];
  const tokens = normalizeName(query).split(' ').filter(Boolean);
  const years = new Set(tokens.filter((t) => YEAR_WORD.test(t)).map(Number));
  const words = tokens.filter((t) => !YEAR_WORD.test(t));
  // A query of only years has nothing to match on.
  if (words.length === 0) return [];
  const excluded = new Set(opts.excludeIds);
  const limit = Math.max(0, Math.min(EDITION_SUGGEST_MAX_LIMIT, Math.floor(opts.limit)));
  return editions
    .filter((e) => e.status === 'confirmed' && !excluded.has(e.id))
    .filter((e) => {
      const haystack = normalizeName(`${e.name} ${e.seriesSlug}`).split(' ');
      return words.every((w) => haystack.some((h) => h.startsWith(w)));
    })
    .sort(
      (a, b) =>
        Number(years.has(b.year)) - Number(years.has(a.year)) ||
        startDateDesc(a.startDate, b.startDate) ||
        b.year - a.year ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit)
    .map(toEditionSuggestion);
}

// Canonical history feed (slice 8.9): only canonical operations, newest first, paged by a keyset cursor on
// (createdAt, id) descending. The operation filter runs in the store query before the limit, never after it.
export const CANONICAL_HISTORY_DEFAULT_LIMIT = 50;
export const CANONICAL_HISTORY_MAX_LIMIT = 100;

export type CanonicalOperation = (typeof CANONICAL_OPERATIONS)[number];

export function isCanonicalOperation(op: string): op is CanonicalOperation {
  return (CANONICAL_OPERATIONS as readonly string[]).includes(op);
}

export interface CanonicalHistoryPageOptions {
  // Default 50. Out-of-range values are clamped to 1..100. Non-integers (NaN, 1.5) are rejected with a RangeError.
  limit?: number;
  // The nextCursor from the previous page. Undefined or null starts at the newest entry.
  cursor?: string | null;
}

export interface CanonicalHistoryEntry {
  id: string;
  operation: CanonicalOperation;
  createdAt: string;
  // Set once the change was undone. Taken from the undone_at column in Supabase, or the stored undoneAt in FileStore.
  undoneAt?: string;
  // The stored manifest as written by the change (a canonical plan entry for the apply path). Narrow it before use.
  manifest: unknown;
}

export interface CanonicalHistoryPage {
  entries: CanonicalHistoryEntry[];
  // Opaque cursor for the next (older) page. Null when there are no older canonical entries.
  nextCursor: string | null;
}

export class CanonicalHistoryCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor(message = 'The history cursor is malformed.') {
    super(message);
    this.name = 'CanonicalHistoryCursorError';
  }
}

interface HistoryKey {
  createdAt: string;
  id: string;
}

// Timestamps as Postgres (timestamptz) or JS (toISOString) prints them. Ids as uuids or simple tokens.
// The fixed character sets keep commas, parentheses and dots out of the cursor, so it is safe in a PostgREST filter.
const KEY_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR_HEX = /^(?:[0-9a-f]{2}){1,1024}$/;

export function normalizeCanonicalHistoryLimit(limit: number | undefined): number {
  if (limit === undefined) return CANONICAL_HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit)) throw new RangeError('limit must be a whole number.');
  return Math.min(CANONICAL_HISTORY_MAX_LIMIT, Math.max(1, limit));
}

// Hex-encoded JSON of {c, i}. Hex keeps it to plain characters, so no Buffer or base64 is needed.
export function encodeCanonicalHistoryCursor(key: HistoryKey): string {
  if (!KEY_TIME.test(key.createdAt) || !KEY_ID.test(key.id)) {
    throw new CanonicalHistoryCursorError('This history entry has an id or timestamp that cannot be paged.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ c: key.createdAt, i: key.id }));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function decodeCanonicalHistoryCursor(cursor: string): HistoryKey {
  const bad = () => new CanonicalHistoryCursorError();
  if (typeof cursor !== 'string' || !CURSOR_HEX.test(cursor)) throw bad();
  const bytes = new Uint8Array(cursor.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(cursor.slice(2 * i, 2 * i + 2), 16);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw bad();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad();
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'c,i') throw bad();
  const { c, i } = record;
  if (typeof c !== 'string' || typeof i !== 'string' || !KEY_TIME.test(c) || !KEY_ID.test(i) || Number.isNaN(Date.parse(c))) throw bad();
  return { createdAt: c, id: i };
}

// True when an entry comes strictly after the cursor in the newest-first order, so it belongs on a later page.
export function isOlderThanCursor(entry: HistoryKey, cursor: HistoryKey): boolean {
  if (entry.createdAt !== cursor.createdAt) return entry.createdAt < cursor.createdAt;
  return entry.id < cursor.id;
}

// Failures of the canonical artist apply and Undo (migration 0037 codes, mapped the same way in both stores):
// 'stale' = P0409 (preview out of date, or the change already undone), 'forbidden' = 42501 (not the owner),
// 'generic' = anything else.
export type CanonicalStoreErrorCode = 'stale' | 'forbidden' | 'generic';

export class CanonicalStoreError extends Error {
  constructor(
    readonly code: CanonicalStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalStoreError';
  }
}

// A performance row as the store reads it. `id` is the performances row ID (Supabase); FileStore has no
// performance IDs, so it leaves `id` out. Never invent one: the planner marks such a plan not SQL-ready.
export type ArtistPerformanceRow = ArtistEditionRow & { id?: string };

// Result of the canonical RPCs (the jsonb they return).
export interface CanonicalApplyResult {
  id: string;
  operation: string;
}

export interface CanonicalUndoResult {
  id: string;
  undone: true;
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
  // Confirmed editions matching the typed words (slice 9.1); see suggestEditionMatches. Never drafts.
  suggestEditions(query: string, opts: { excludeIds: string[]; limit: number }): Promise<EditionSuggestion[]>;
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
  // Canonical artist apply and Undo (migration 0037). Both take only the server-built plan entry
  // (planArtistChange().entry), never a client-built plan. Serialized per store instance; owner only.
  // The fingerprint is computed from the current state of the rows the change touches.
  canonicalArtistFingerprint(entry: SqlCanonicalEntry): Promise<string>;
  applyCanonicalArtistChange(entry: SqlCanonicalEntry, fingerprint: string): Promise<CanonicalApplyResult>;
  // Restores the stored "before" side of a history entry, after checking its current "after" side.
  undoCanonicalArtistChange(historyId: string): Promise<CanonicalUndoResult>;
  // Every canonical artist (canonical_artists), for the owner's Global Archive.
  listArtists(): Promise<ArtistIdentity[]>;
  // Removes canonical artists (a merged-away one). Only after its performances moved.
  deleteArtists(keys: string[]): Promise<void>;
  // Performances (edition links) of these artists, each with its edition ID.
  artistPerformances(keys: string[]): Promise<ArtistPerformanceRow[]>;
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
  // Canonical operations only, newest first, one page (slice 8.9). Owner only. Does not change listEntityHistory.
  listCanonicalHistoryPage(options?: CanonicalHistoryPageOptions): Promise<CanonicalHistoryPage>;

  // Share page links (0015, src/server/share/). Optional: only the share
  // page needs the table.
  listShareLinks(): Promise<ShareLink[]>;
  getShareLinkByHash(codeHash: string): Promise<ShareLink | null>;
  putShareLink(link: ShareLink): Promise<void>;
  // Your events with only the columns the share page reads
  // (SHARE_EVENT_COLUMNS); every other field comes back empty.
  listShareEvents(): Promise<LoggedEvent[]>;
  // AI call log (migration 0038). Counts and sizes only: never page text, prompts, quotes or names.
  addAiCall(row: AiCallRow): Promise<void>;
  // Newest first.
  listAiCalls(limit: number): Promise<AiCallRow[]>;
  // Returns how many rows were deleted.
  deleteAiCallsBefore(cutoff: Date): Promise<number>;

  // Shared occurrences (0041, 0042; slice 11.9). Service key only. Same behavior in both stores.
  // Returns the canonical venue for this name and place, creating it once; also records the normalized name as an alias.
  upsertVenue(v: { name: string; city?: string; region?: string; country?: string }): Promise<CanonicalVenue>;
  // The one venue holding this normalized alias; null when none, or when more than one venue holds it (never guessed).
  findVenueByAlias(aliasNormalized: string): Promise<CanonicalVenue | null>;
  // Idempotent on (alias, venue). A source's external ID already held by another venue throws ExternalIdConflictError.
  addVenueAlias(venueId: string, aliasNormalized: string, source?: string, externalId?: string): Promise<void>;
  findEditionByExternalId(source: string, externalId: string): Promise<Edition | null>;
  // 'added' the first time, 'exists' when the same pair already points at this edition.
  // The same pair on a different edition throws ExternalIdConflictError and changes nothing.
  addEditionExternalId(editionId: string, source: string, externalId: string): Promise<'added' | 'exists'>;
  // Append-only. before and after must not hold personal fields.
  recordEditionChange(c: { editionId: string; actor: string; reason?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }): Promise<EditionChange>;
  // Newest first.
  listEditionChanges(editionId: string): Promise<EditionChange[]>;
  // Sets undone_at once. False when the change is unknown or was already undone.
  markChangeUndone(changeId: string): Promise<boolean>;
  // Throws PersonalFieldError when the payload holds a personal field at any depth.
  addReviewItem(i: { kind: ReviewQueueKind; editionId?: string; eventId?: string; payload: Record<string, unknown> }): Promise<ReviewQueueItem>;
  // Oldest first.
  listReviewItems(q?: { status?: string; kind?: ReviewQueueKind }): Promise<ReviewQueueItem[]>;
  // Closes an open item. False when it is unknown or no longer open.
  resolveReviewItem(id: string, resolvedBy: string, status: string): Promise<boolean>;
  // Folds dropId into keepId (the 0042 merge_editions function in Supabase). Returns the counts moved.
  mergeEditions(keepId: string, dropId: string, actor: string, reason?: string): Promise<MergeSummary>;
}

export type MergeSummary = Record<string, unknown>;

// 'confirmed' is the old name of 'verified' (0041 keeps both until a later conversion).
export function isVerifiedStatus(status: string | undefined | null): boolean {
  return status === 'verified' || status === 'confirmed';
}

// Same (source, external_id) already belongs to something else.
export class ExternalIdConflictError extends Error {
  constructor(readonly source: string, readonly externalId: string, readonly existingId: string) {
    super(`External ID ${source}:${externalId} already belongs to ${existingId}`);
    this.name = 'ExternalIdConflictError';
  }
}

export class PersonalFieldError extends Error {
  constructor(readonly field: string) {
    super(`Shared data must not hold the personal field "${field}"`);
    this.name = 'PersonalFieldError';
  }
}

const PERSONAL_KEYS = new Set(['companions', 'notes', 'rating', 'price', 'attendance']);

// Deep check of keys (case-insensitive). Shared tables, traces and the review queue never hold these.
export function assertNoPersonalFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) assertNoPersonalFields(v);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (PERSONAL_KEYS.has(k.toLowerCase())) throw new PersonalFieldError(k);
      assertNoPersonalFields(v);
    }
  }
}

// Stable id for a canonical venue: same normalized name and place, same id, in both stores.
export function venueIdFor(v: { name: string; city?: string; region?: string; country?: string }, normalize: (s: string) => string): string {
  return 'venue:' + [v.name, v.city, v.region, v.country].map((x) => normalize(x ?? '').replace(/ /g, '-')).join('|');
}

export type AiCallFeature = 'lineup_extract' | 'details_extract' | 'discovery';
export type AiCallOutcome = 'ok' | 'invalid_json' | 'quota' | 'busy' | 'blocked_by_guard' | 'error';

// One ai_calls row, camelCased. createdAt is an ISO string, as on other store rows.
export interface AiCallRow {
  id: string;
  createdAt: string;
  feature: AiCallFeature;
  jobId: string | null;
  eventId: string | null;
  userId: string | null;
  provider: string;
  model: string;
  sourceDocumentId: string | null;
  inputChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estCostUsd: number | null;
  durationMs: number | null;
  outcome: AiCallOutcome;
  errorCode: string | null;
  guardReason: string | null;
  namesReturned: number | null;
  namesVerbatim: number | null;
  namesRejected: number | null;
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
