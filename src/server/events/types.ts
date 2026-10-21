import type { JobStatus, SourceType } from '../lineup/types';
import type { Billing } from '../lineup/billing';

// Your personal log: one LoggedEvent per thing you attended. Stage 1 fills its
// name, date and place; stage 2 (the lineup lookup) links it to a canonical
// edition. See REQUIREMENTS.md and ARCHITECTURE.md.

export type EventField = 'startDate' | 'endDate' | 'venue' | 'city' | 'country';
export const EVENT_FIELDS: EventField[] = ['startDate', 'endDate', 'venue', 'city', 'country'];

export interface EventFacts {
  name: string;
  year?: number;
  month?: number; // 1-12, when you gave a month without a day
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  venue?: string;
  city?: string;
  country?: string;
}

// Where a field's value came from: you, or a cited source.
export interface FieldSource {
  sourceType: SourceType;
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
  city?: string;
  country?: string;
  // quote: the words a web page used for the date, when it came from web search.
  sources: Array<{ sourceType: SourceType; sourceUrl: string; fields: EventField[]; quote?: string }>;
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
  set?: SetKind;
  b2b?: string[];
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
}

// Concert or festival. Worked out from the event (scale.ts) unless you set it.
export type EventKind = 'concert' | 'festival';

export interface LoggedEvent extends EventFacts {
  id: string;
  input: string; // the line you typed
  sources: Partial<Record<EventField, FieldSource>>;
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
  weather?: EventWeather;
  daysAttended: string[];
  companions: string[];
  rating?: number;
  ticketPrice?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// What the event list shows about a running or finished lineup lookup.
export interface LineupSummary {
  jobId: string;
  status: JobStatus;
  actCount: number;
  waitingReason?: string;
  nextAttemptAt?: string;
}
