// Core types for the source-first lineup pipeline. See ARCHITECTURE.md.

import type { Billing } from './billing';

export type SourceType =
  | 'clashfinder'
  | 'promoter'
  | 'wayback'
  | 'ticketmaster'
  | 'setlistfm'
  | 'musicbrainz'
  | 'discovered'
  | 'email' // your own ticket emails (stage 1 only, never lineup evidence)
  | 'user';

// billed: announced on a lineup; performed: a post-show record says they played;
// crowd: a crowd-sourced listing (Clashfinder).
export type EvidenceKind = 'billed' | 'performed' | 'crowd';

export interface LookupInput {
  eventName: string;
  year: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  venue?: string;
  city?: string;
  country?: string;
  lineupUrl?: string; // promoter lineup page or a Clashfinder URL
  notes?: string;
}

export interface SourceDocument {
  id: string;
  url: string;
  sourceType: SourceType;
  fetchedAt: string;
  contentHash: string;
  contentType: 'json' | 'html' | 'text';
  body: string;
}

export interface PerformerClaim {
  id: string;
  jobId: string;
  documentId: string;
  sourceType: SourceType;
  sourceUrl: string;
  name: string;
  quotedSpan: string;
  evidence: EvidenceKind;
  day?: string; // YYYY-MM-DD
  stage?: string;
  startTime?: string;
  endTime?: string;
  mbid?: string;
  // Set only when the quoted span itself bills the act as headliner or
  // support ("X with special guest Y"); see billing.ts.
  billing?: Billing;
  extractor: string; // adapter id or 'gemini:<model>'
  extractorVersion: string;
  createdAt: string;
}

export interface FactClaim<T = string> {
  value: T;
  sourceType: SourceType;
  sourceUrl: string;
}

export interface EditionFacts {
  name: FactClaim[];
  startDate: FactClaim[];
  endDate: FactClaim[];
  venue: FactClaim[];
  city: FactClaim[];
  country: FactClaim[];
}

export type NewPerformerClaim = Omit<PerformerClaim, 'id' | 'jobId' | 'createdAt'>;

export interface AdapterResult {
  documents: SourceDocument[];
  performers: NewPerformerClaim[];
  facts: Partial<EditionFacts>;
  // Unstructured documents that need Gemini extraction.
  extractionQueue: string[]; // document ids
  notes: string[];
  // Learned by the adapter, persisted on the series (e.g. Clashfinder slug).
  seriesHints?: Partial<SeriesRecord>;
}

export interface AdapterContext {
  input: LookupInput;
  editionKey: string;
  series: SeriesRecord | null;
  now: Date;
  fetcher: Fetcher;
}

export interface SourceAdapter {
  id: SourceType;
  enabled(): boolean;
  collect(ctx: AdapterContext): Promise<AdapterResult>;
}

export interface FetchResponse {
  url: string; // final url after redirects
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated?: boolean; // the body was cut at maxBytes
}

export interface Fetcher {
  get(
    url: string,
    init?: { headers?: Record<string, string>; timeoutMs?: number; maxRetries?: number; maxBytes?: number },
  ): Promise<FetchResponse>;
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_quota'
  | 'needs_review'
  | 'no_data'
  | 'confirmed'
  | 'failed';

export type JobStage = 'collect' | 'extract' | 'discover' | 'merge' | 'done';

// One set as a source times it (Clashfinder gives stage, start and end).
export interface SetTime {
  day?: string; // YYYY-MM-DD, the festival day
  stage?: string;
  start?: string; // "YYYY-MM-DD HH:MM", local to the event
  end?: string;
}

export interface CandidateSource {
  sourceType: SourceType;
  sourceUrl: string;
  quotedSpan: string;
  evidence: EvidenceKind;
  extractor: string;
  sets?: SetTime[]; // the sets this source times for the act, if any
}

// From the lineup's own words ("A b2b B", "Porter Robinson (DJ Set)", "Kaskade: Redux"); see actName.ts.
export interface ActName {
  parts: string[];
  set?: string;
}

export interface CandidatePerformer {
  key: string; // normalized merge key
  slotId?: string; // identifier of the performance slot (shared by B2B partners)
  alias?: string; // collaborative project moniker (e.g. Subjohnics, Kx5)
  name: string;
  mbid?: string;
  days: string[];
  stages: string[];
  status: 'billed' | 'performed';
  billing?: Billing; // when every source that states a role agrees
  confidence: number; // 0..1, computed from sources
  // Sources that gave a full lineup for the edition without this act.
  missingFrom?: SourceType[];
  flagged: boolean; // low evidence, needs a look
  // From the lineup's own words ("A b2b B", "X DJ Set"); see actName.ts.
  set?: string;
  b2b?: string[]; // keys of the acts billed with it as a B2B
  sources: CandidateSource[];
}

export interface CandidateFacts {
  name?: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string;
  country?: string;
  sources: Record<string, FactClaim[]>;
}

export interface CandidateLineup {
  editionKey: string;
  cached: boolean;
  facts: CandidateFacts;
  performers: CandidatePerformer[];
  droppedCount: number; // names removed by blocklist or verification
}

export interface JobLogEntry {
  at: string;
  message: string;
}

export interface LookupJob {
  id: string;
  kind: 'lineup' | 'resolve_artists';
  input: LookupInput;
  editionKey: string;
  status: JobStatus;
  stage: JobStage;
  attempts: number;
  nextAttemptAt?: string;
  waitingReason?: string;
  lastError?: string;
  pendingExtraction: string[]; // document ids still to extract
  discoveryDone: boolean;
  facts: Partial<EditionFacts>;
  candidate?: CandidateLineup;
  editionId?: string;
  eventId?: string; // the logged event this lookup was started from
  userId?: string; // the member who started it (multi-user mode)
  log: JobLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export type SeriesKind = 'festival' | 'tour';

export interface SeriesRecord {
  slug: string;
  name: string;
  kind?: SeriesKind;
  brand?: string;
  city?: string;
  region?: string;
  country?: string;
  aliases?: string[];
  lineupUrl?: string; // learned from confirmed promoter sources
  clashfinderSlugs?: Record<string, string>; // year -> clashfinder event slug
  sourcePriority?: SourceType[]; // user override of trust order
}

export interface SeriesSummary extends SeriesRecord {
  editionCount: number;
}

export interface EditionWeekend {
  weekend: number;
  startDate: string;
  endDate?: string;
}

export interface EditionPerformance {
  slotId?: string; // identifier of the performance slot (shared by B2B partners)
  artistKey: string;
  alias?: string; // collaborative project moniker (e.g. Subjohnics, Kx5)
  name: string;
  mbid?: string;
  set?: string;
  b2b?: string[]; // partners in this B2B performance
  // Kept whole by you: a name with a splitting marker (" X ") that is one act. Never split.
  oneAct?: boolean;
  days: string[];
  stages: string[];
  status: 'billed' | 'performed' | 'cancelled';
  billing?: Billing; // absent: no lead stated (filed under Artist)
  confidence: number;
  sources: CandidateSource[];
}

export interface Edition {
  id: string;
  key: string; // series_slug/year
  seriesSlug?: string;
  seriesName?: string;
  seriesBrand?: string;
  seriesAliases?: string[];
  seriesKind?: SeriesKind;
  seriesCity?: string;
  seriesRegion?: string;
  seriesCountry?: string;
  year: number;
  name: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string;
  region?: string;
  country?: string;
  weekends?: EditionWeekend[];
  // 'confirmed' means 'verified'. Migration 0041 accepts both and converts nothing; a later step converts the
  // rows. It stays in the union so code written before slice 11.9 compiles; read it as 'verified'.
  status: EditionStatus | 'confirmed';
  venueId?: string; // canonical_venues.id (0041)
  subjectKey?: string; // shared artist key for a headline show, series slug for a festival (0041)
  hasLineup?: boolean; // 0041
  performances: EditionPerformance[];
  confirmedAt?: string;
  updatedAt: string;
  // Admin-curated fact provenance (migration 0034): the owner's note for name, dates, venue, city.
  factSourceNote?: string;
}

export type EditionHeader = Omit<Edition, 'performances'>;

export interface EditionArtistRef {
  editionId: string;
  artistKey: string;
  name: string;
  status: EditionPerformance['status'];
}

export interface SourceStat {
  sourceType: SourceType;
  scope: string; // series slug or '*'
  accepted: number;
  rejected: number;
}

export interface Correction {
  id: string;
  editionKey: string;
  kind: 'rejected' | 'renamed' | 'added';
  original?: string;
  corrected?: string;
  sourceTypes: SourceType[];
  sourceUrls: string[];
  createdAt: string;
}

export interface BlocklistEntry {
  domain: string; // '*' for global
  normalized: string;
  rejections: number;
}

export interface ExtractionExample {
  domain: string;
  excerpt: string;
  names: string[];
  createdAt: string;
}

export interface QuotaUsage {
  key: string; // provider:model:window
  used: number;
  exhaustedUntil?: string;
}

export interface ArtistIdentity {
  key: string;
  name: string;
  mbid?: string;
  resolvedAt?: string;
}

// Shared occurrences (migrations 0041 and 0042; not used by code yet) ----------------------------------

export type EditionStatus = 'draft' | 'provisional' | 'verified';

export interface CanonicalVenue {
  id: string;
  name: string;
  city?: string;
  region?: string;
  country?: string;
  createdAt: string;
}

export interface VenueAlias {
  venueId: string;
  aliasNormalized: string;
  source?: string;
  externalId?: string;
}

export interface EditionExternalId {
  editionId: string;
  source: string;
  externalId: string;
}

// One recorded change to a shared edition; append-only, only undoneAt is ever set later.
export interface EditionChange {
  id: string;
  editionId: string;
  at: string;
  actor: string;
  reason?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  undoneAt?: string;
}

export type ReviewQueueKind = 'override' | 'merge_suggestion' | 'provisional' | 'formatting' | 'failed_lookup';

// Payloads hold edition facts and field names only, never personal fields.
export interface ReviewQueueItem {
  id: string;
  kind: ReviewQueueKind;
  editionId?: string;
  eventId?: string;
  payload: Record<string, unknown>;
  status: string; // 'open' by default
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// logged_events.captured: the shared-fact fields as first typed or imported. Written once.
export interface CapturedFields {
  name?: string;
  year?: number | null;
  month?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  venue?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
}

// logged_events.overrides: the fields the person changed while linked to an edition.
export type EventOverrides = Partial<CapturedFields>;

// Optional extra columns of logged_events (0041), for the stores in slice 11.9 onward.
export interface LoggedEventInheritance {
  captured?: CapturedFields | null;
  overrides?: EventOverrides;
}
