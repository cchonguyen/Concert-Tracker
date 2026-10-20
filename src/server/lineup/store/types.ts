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
  upsertEdition(edition: Edition): Promise<void>;
  listEditions(limit: number): Promise<Edition[]>;

  getQuota(key: string): Promise<QuotaUsage | null>;
  setQuota(usage: QuotaUsage): Promise<void>;

  // Normalized alias -> canonical display name.
  getAliases(): Promise<Record<string, string>>;
  putAlias(normalizedAlias: string, canonicalName: string): Promise<void>;

  getBlocklist(domains: string[]): Promise<BlocklistEntry[]>;
  bumpBlocklist(domain: string, normalized: string): Promise<void>;

  getSourceStats(): Promise<SourceStat[]>;
  bumpSourceStat(sourceType: SourceType, scope: string, accepted: boolean): Promise<void>;

  addCorrection(correction: Correction): Promise<void>;

  getExamples(domain: string): Promise<ExtractionExample[]>;
  addExample(example: ExtractionExample): Promise<void>;

  // Your event log (stage 1), separate from canonical editions.
  putEvent(event: LoggedEvent): Promise<void>;
  getEvent(id: string): Promise<LoggedEvent | null>;
  listEvents(): Promise<LoggedEvent[]>;
  deleteEvent(id: string): Promise<void>;

  getArtist(key: string): Promise<ArtistIdentity | null>;
  upsertArtist(artist: ArtistIdentity): Promise<void>;
  listUnresolvedArtists(limit: number): Promise<ArtistIdentity[]>;
}

export const MAX_EXAMPLES_PER_DOMAIN = 3;
