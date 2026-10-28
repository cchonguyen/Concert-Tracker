import type { JobStatus, SourceType } from '../lineup/types';
import type { Billing } from '../lineup/billing';
import type { Attendance } from './attendance';

// Your personal log: one LoggedEvent per thing you attended. Stage 1 fills its
// name, date and place; stage 2 (the lineup lookup) links it to a canonical
// edition. See REQUIREMENTS.md and ARCHITECTURE.md.

export type EventField = 'startDate' | 'endDate' | 'venue' | 'city' | 'region' | 'country';
export const EVENT_FIELDS: EventField[] = ['startDate', 'endDate', 'venue', 'city', 'region', 'country'];

export interface EventFacts {
  name: string;
  year?: number;
  month?: number; // 1-12, when you gave a month without a day
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  venue?: string;
  city?: string; // the city alone ("Las Vegas")
  region?: string; // the state or province: "NV" in the US and Canada, in full elsewhere
  country?: string;
}

// Where a field's value came from: you, a cited source, or (city, state and
// country) the place of the event's venue (src/server/entities/venuePlace.ts).
export interface FieldSource {
  sourceType: SourceType | 'venue';
  sourceUrl?: string;
  quote?: string; // the words it was read from (an email, say)
}

// A suggestion from a structured source during stage 1 research.
export interface DetailCandidate {
  id: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string; // "City, ST" as sources give it; split when it is stored
  region?: string;
  country?: string;
  // quote: the words a web page used for the date, when it came from web search.
  // readBy: 'gemini' when you asked Gemini to read the page (the quote is still
  // checked against the page in code).
  sources: Array<{ sourceType: SourceType; sourceUrl: string; fields: EventField[]; quote?: string; readBy?: 'gemini' }>;
  // Performers the listing names (Ticketmaster attractions, the setlist.fm
  // artist). Used only to confirm an act named in the event's own name.
  performers?: Array<{ name: string; sourceType: SourceType; sourceUrl: string }>;
}

// pending: not researched yet; needs_date: research needs at least a year;
// matched: a source confirmed the date you gave and filled empty fields;
// choose: candidates wait for your pick; none: nothing found;
// resolved: you picked or dismissed; off: no stage 1 source is configured.
export type DetailsStatus = 'pending' | 'needs_date' | 'matched' | 'choose' | 'none' | 'resolved' | 'off';

export interface EventDetails {
  status: DetailsStatus;
  candidates: DetailCandidate[];
  notes: string[];
  checkedAt?: string;
}

// How an act played, as you mark it. Never filled from a lineup or a guess.
export type SetKind = 'dj' | 'live';

// Artist: headliner, or no role stated. Supporting: role 'support', which
// needs a source that says so, or you.
// set and b2b are yours only. Acts in a B2B are still separate seen acts, so
// each one is credited; b2b lists the keys of the others on this event.
export interface SeenAct {
  key: string; // normalized name
  name: string;
  from: 'you' | 'lineup';
  role?: Billing;
  roleFrom?: 'you' | 'lineup';
  favourite?: boolean; // your set of the night; at most one per event
  set?: SetKind; // in a B2B: how the B2B was played
  b2b?: string[];
  // In a B2B, you also saw this act play on its own at the event; soloSet is
  // how that set was played. Still one seen act, credited once.
  solo?: boolean;
  soloSet?: SetKind;
  // The artist record this act points at (src/server/entities/). Filled from
  // the name on every save while names stay the source of truth.
  artistId?: string;
}

// The weather where and when the event was, from the Open-Meteo archive
// (weather.ts). Fetched only when you ask, and only for a city it can place
// exactly as you wrote it.
export interface WeatherDay {
  date: string; // YYYY-MM-DD
  high?: number; // °C
  low?: number; // °C
  precipitation?: number; // mm
  code?: number; // WMO weather code
}

export interface EventWeather {
  place: string; // the place Open-Meteo matched to your city
  latitude: number;
  longitude: number;
  days: WeatherDay[];
  sourceUrl: string;
  checkedAt: string;
  // The event's city changed after this was looked up (its venue's place
  // filled another one). Kept as it is; look it up again to replace it.
  cityChanged?: boolean;
}

// Concert or festival. Worked out from the event (scale.ts) unless you set it.
export type EventKind = 'concert' | 'festival';

export interface LoggedEvent extends EventFacts {
  id: string;
  input: string; // the line you typed
  // Where each fact came from; `ticketPrice` only when a ticket email gave it.
  sources: Partial<Record<EventField | 'ticketPrice', FieldSource>>;
  details: EventDetails;
  lineupJobId?: string;
  editionId?: string;
  seen: SeenAct[];
  kind?: EventKind; // your choice; absent means worked out by the rule
  // What kind of night it was (club night, warehouse party, block party, ...),
  // in your words. Separate from kind, and never filled on its own.
  format?: string;
  // The festival or tour this event is one edition of ("EDC Las Vegas"), in
  // your words. Editions with the same series show as "<series> <year>".
  // Set only by you; the Table can offer a name from your own event names.
  series?: string;
  // Which weekend of a festival that runs more than one (Weekend 1, 2, ...),
  // as you pick it. Shown with the series.
  weekend?: number;
  // 'planned': added before it happened, not yet confirmed; 'missed': you
  // said you didn't go. Absent: you went. See attendance.ts.
  attendance?: Attendance;
  weather?: EventWeather;
  daysAttended: string[];
  companions: string[];
  rating?: number;
  ticketPrice?: number;
  notes?: string;
  // The records this event's names point at, filled from those names on
  // every save (src/server/entities/link.ts). Absent when the entity tables
  // (migration 0014) are not there yet.
  refs?: EventRefs;
  createdAt: string;
  updatedAt: string;
}

export interface EventRefs {
  venueId: string | null;
  placeId: string | null;
  seriesId: string | null;
  companionIds: Array<string | null>; // in the order of `companions`; null for a name with no letters or digits
}

// What the event list shows about a running or finished lineup lookup.
export interface LineupSummary {
  jobId: string;
  status: JobStatus;
  actCount: number;
  waitingReason?: string;
  nextAttemptAt?: string;
}
