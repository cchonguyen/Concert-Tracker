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
import type { LineupFacts } from '../../events/scale';
import { EmailImport } from '../../events/email/types';

// Persistence boundary for the lineup pipeline. Two implementations:
// fileStore (local dev, no setup) and supabaseStore (durable, used when
// SUPABASE_URL is configured). Both must behave identically.
export interface LineupStore {
  readonly kind: 'file' | 'supabase';

  createJob(job: LookupJob): Promise<void>;
  getJob(id: string): Promise<LookupJob | null>;
  updateJob(job: LookupJob): Promise<void>;
  listJobs(limit: number): Promise<LookupJob[]>;
  getJobs(ids: string[]): Promise<LookupJob[]>;
  // Queued or waiting jobs whose nextAttemptAt (if any) has passed.
  dueJobs(now: Date, limit: number): Promise<LookupJob[]>;

  // Deduplicates on (url, contentHash) and returns the stored document.
  putDocument(doc: SourceDocument): Promise<SourceDocument>;
  getDocument(id: string): Promise<SourceDocument | null>;

  addPerformerClaims(claims: PerformerClaim[]): Promise<void>;
  listPerformerClaims(jobId: string): Promise<PerformerClaim[]>;

  getSeries(slug: string): Promise<SeriesRecord | null>;
  upsertSeries(series: SeriesRecord): Promise<void>;

  getEditionByKey(key: string): Promise<Edition | null>;
  getEdition(id: string): Promise<Edition | null>;
  getEditions(ids: string[]): Promise<Edition[]>;
  upsertEdition(edition: Edition): Promise<void>;
  listEditions(limit: number): Promise<Edition[]>;
  // Size of each confirmed lineup, by edition id, for Concert or Festival.
  editionLineupFacts(ids: string[]): Promise<Record<string, LineupFacts>>;

  getQuota(key: string): Promise<QuotaUsage | null>;
  setQuota(usage: QuotaUsage): Promise<void>;

  // Normalized alias -> canonical display name.
  getAliases(): Promise<Record<string, string>>;
  putAliases(aliases: Record<string, string>): Promise<void>;

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
  deleteEvent(id: string): Promise<void>;

  // Ticket emails waiting for your review (stage 1 from email).
  listImports(): Promise<EmailImport[]>;
  putImports(rows: EmailImport[]): Promise<void>;
  // Small JSON settings by key (app_settings): the Gmail sign-in, how far
  // your mail has been read.
  getSetting<T>(key: string): Promise<T | null>;
  putSetting<T>(key: string, data: T): Promise<void>;

  getArtist(key: string): Promise<ArtistIdentity | null>;
  upsertArtist(artist: ArtistIdentity): Promise<void>;
  // Adds the artists not stored yet; existing ones are left as they are.
  ensureArtists(artists: ArtistIdentity[]): Promise<void>;
  listUnresolvedArtists(limit: number): Promise<ArtistIdentity[]>;
}

export const MAX_EXAMPLES_PER_DOMAIN = 3;
