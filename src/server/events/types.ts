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

// Artist: headliner, or no role stated. Supporting: role 'support', which
// needs a source that says so, or you.
export interface SeenAct {
  key: string; // normalized name
  name: string;
  from: 'you' | 'lineup';
  role?: Billing;
  roleFrom?: 'you' | 'lineup';
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
