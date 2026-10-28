import type { LoggedEvent } from '../events/types';

// The share page (/s/<code>): a read-only page of your concert history that
// anyone with the link can open without signing in. See "Share page" in
// ARCHITECTURE.md. Everything a visitor can see is in ShareView; nothing else
// about an event leaves the server.

// What the owner chose for the link. The display name is yours to set (it is
// never written into the code). The time zone decides what "today" is, so an
// event only appears once it is over where you are.
export interface ShareSettings {
  displayName: string;
  timeZone: string;
  showDates: boolean;
  showVenues: boolean;
  showFormat: boolean;
}

// One row of share_links (0015). Only a hash of the code is stored, so the
// table alone cannot rebuild a working link.
export interface ShareLink {
  id: string;
  codeHash: string;
  settings: ShareSettings;
  createdAt: string;
  revokedAt?: string;
}

// The columns of logged_events the share page reads. Companions, notes,
// rating, price, weather, sources and the line you typed are never loaded.
// `details` is read only so eventScale can tell a festival from a concert.
export const SHARE_EVENT_COLUMNS = [
  'id',
  'name',
  'year',
  'month',
  'start_date',
  'end_date',
  'venue',
  'city',
  'region',
  'country',
  'details',
  'edition_id',
  'seen',
  'kind',
  'format',
  'series',
  'weekend',
  'attendance',
  'created_at',
  'updated_at',
] as const;

// An event as the share page loads it: the fields above, with every other
// field empty. The file store (local development) uses this so it behaves
// like the Supabase store.
export function shareEventOnly(e: LoggedEvent): LoggedEvent {
  return {
    id: e.id,
    input: '',
    name: e.name,
    year: e.year,
    month: e.month,
    startDate: e.startDate,
    endDate: e.endDate,
    venue: e.venue,
    city: e.city,
    region: e.region,
    country: e.country,
    sources: {},
    details: e.details,
    editionId: e.editionId,
    seen: e.seen,
    kind: e.kind,
    format: e.format,
    series: e.series,
    weekend: e.weekend,
    attendance: e.attendance,
    daysAttended: [],
    companions: [],
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

export interface ShareEvent {
  title: string;
  kind?: 'concert' | 'festival';
  city?: string; // with its state, as the app shows it ("Las Vegas, NV")
  country?: string;
  acts: string[]; // names of the acts you saw
  when?: string; // only with showDates
  venue?: string; // only with showVenues
  formats?: string[]; // only with showFormat
}

// Everything the share page shows. Built only by buildShareView.
export interface ShareView {
  displayName: string;
  totals: {
    events: number;
    festivals: number;
    concerts: number;
    acts: number;
    cities: number;
    states: number;
    countries: number;
    firstYear?: number;
    lastYear?: number;
  };
  mostSeen: Array<{ name: string; count: number }>;
  series: Array<{ name: string; years: number[] }>;
  years: Array<{ year: number; events: ShareEvent[] }>;
  cities: Array<{ name: string; count: number }>;
}
