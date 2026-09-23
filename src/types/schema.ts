export type BillingRole = 'headliner' | 'support' | 'guest' | 'festival_lineup';

export interface Venue {
  id: string;
  name: string;
  city: string;
  state: string;
  country: string;
  isOutdoor?: boolean;
  capacity?: number;
}

export interface Artist {
  id: string;
  name: string;
  musicbrainz_id?: string | null;
  disambiguation?: string;
  genres?: string[];
}

export interface EventAppearance {
  id: string;
  event_id: string;
  artist_id: string;
  billing_role: BillingRole;
  billing_order: number;
  stage_name?: string;
}

export interface FestivalDayAttendance {
  date: string; // YYYY-MM-DD
  day_index: number; // 1, 2, 3...
  label?: string; // e.g. "Day 1 (Friday)", "Sunday - Day 3"
  attended: boolean;
  notes?: string;
}

export interface ConcertEvent {
  id: string;
  name: string;
  tour_name?: string;
  event_date: string; // YYYY-MM-DD (start date for festivals)
  is_festival?: boolean;
  end_date?: string; // YYYY-MM-DD for multi-day runs
  festival_days?: FestivalDayAttendance[];
  venue_id: string;
  created_at: string;
  notes?: string;
  setlist_confirmed: boolean;
  confidence_score: number;
  source_urls: string[];
  ticket_price?: number;
  seating_tier?: string;
  companions?: string[];
  attendance_status: 'attended' | 'upcoming' | 'wishlist';
  rating?: number;
  engine_metadata?: EngineMetadata;
  setlist_tracks?: {
    order: number;
    title: string;
    isEncore?: boolean;
    isCover?: boolean;
    originalArtist?: string;
  }[];
}

// Denormalized/Joined representation for UI consumption
export interface PopulatedEvent extends ConcertEvent {
  venue: Venue;
  appearances: (EventAppearance & {
    artist: Artist;
  })[];
}

// Extraction input staging
export interface StagingInput {
  concertName: string;
  dateHint?: string;
  endDateHint?: string;
  attendedDaysHint?: string;
  venueHint?: string;
  cityHint?: string;
  tourHint?: string;
  notesHint?: string;
}

// Gemini Grounded Extraction Output Schema
export interface ExtractedArtist {
  name: string;
  billingOrder: number;
  role: BillingRole;
  stage?: string;
}

export interface ExtractedVenue {
  name: string;
  city: string;
  state: string;
  country: string;
  isOutdoor?: boolean;
  capacity?: number;
}

export interface ExtractedFestivalDay {
  date: string;
  dayIndex: number;
  label?: string;
  attended?: boolean;
  notes?: string;
}

export interface ExtractedEventManifest {
  eventName: string;
  tourName: string;
  eventDate: string; // ISO start date (YYYY-MM-DD)
  isFestival?: boolean;
  isMultiDay?: boolean;
  endDate?: string; // ISO end date (YYYY-MM-DD)
  festivalDays?: ExtractedFestivalDay[];
  venue: ExtractedVenue;
  artists: ExtractedArtist[];
  setlistConfirmed: boolean;
  confidenceScore: number;
  notes: string;
  sourceUrls: string[];
  searchQueriesUsed?: string[];
  groundingSources?: {
    title: string;
    url: string;
  }[];
  suggestedSetlist?: {
    order: number;
    title: string;
    isEncore?: boolean;
    isCover?: boolean;
    originalArtist?: string;
  }[];
  engineMetadata?: EngineMetadata;
}

export interface ScanningCues {
  rawTokens: string[];
  headliner?: string;
  supportingActs: string[];
  venueCue?: string;
  municipalityCue?: string;
  dateCue?: string;
  endDateCue?: string;
  tourCue?: string;
  isFestival: boolean;
  isMultiDay: boolean;
  estimatedDays?: number;
}

export interface EngineMetadata {
  extractionModel: string;
  confidenceScore: number;
  executionTimeMs: number;
  fallbackTriggered: boolean;
  fallbackReason?: string;
  scanSteps: string[];
  cuesDetected: ScanningCues;
  synthesizedSummary: string;
  timestamp: string;
}

export interface TransformedIngestionPayload {
  event: Omit<ConcertEvent, 'id' | 'created_at'>;
  venue: Omit<Venue, 'id'>;
  artists: {
    artist: Omit<Artist, 'id'>;
    appearance: {
      billing_role: BillingRole;
      billing_order: number;
      stage_name?: string;
    };
  }[];
  metadata: EngineMetadata;
}

// Telemetry & Analytics Interfaces
export interface ArtistAffinityMetric {
  artistId: string;
  artistName: string;
  mbid?: string | null;
  totalAppearances: number;
  headlineCount: number;
  supportCount: number;
  festivalCount: number;
  firstSeenDate: string;
  lastSeenDate: string;
  affinityTier: 'Obsession' | 'Core Favorite' | 'Regular' | 'Occasional';
}

export interface VenueLoyaltyMetric {
  venueId: string;
  venueName: string;
  location: string;
  visitCount: number;
  isOutdoor: boolean;
  firstVisit: string;
  lastVisit: string;
  loyaltyRank: number;
}

export interface TemporalVelocityMetric {
  periodKey: string; // e.g. "2024-10" or "2024"
  label: string;
  count: number;
  totalSpend: number;
  headliners: string[];
}

export interface LineupOverlapMetric {
  primaryHeadliner: string;
  supportingAct: string;
  sharedShowsCount: number;
  tours: string[];
  events: {
    eventName: string;
    date: string;
  }[];
}

export interface FestivalAttendanceMetric {
  eventId: string;
  eventName: string;
  tourName?: string;
  startDate: string;
  endDate?: string;
  totalDays: number;
  attendedDaysCount: number;
  attendancePercentage: number;
  attendedDates: string[];
  days: FestivalDayAttendance[];
}

