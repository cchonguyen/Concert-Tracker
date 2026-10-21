import type { Edition, LookupJob, SourceType } from '../server/lineup/types';
import type { ConfirmRequest } from '../server/lineup/learning';
import type { DetailCandidate, EventField, LineupSummary, LoggedEvent } from '../server/events/types';
import type { EventPatch } from '../server/events/service';
import type { EmailImport } from '../server/events/email/types';
import type { ArtistSuggestion } from '../server/events/artists';
import type { LineupFacts } from '../server/events/scale';
import type { CityPoint } from '../server/events/place';

export type {
  LookupJob,
  Edition,
  ConfirmRequest,
  LoggedEvent,
  LineupSummary,
  DetailCandidate,
  EventField,
  EventPatch,
  EmailImport,
  ArtistSuggestion,
  LineupFacts,
};

export interface LineupStatus {
  store: 'file' | 'supabase';
  sources: Array<{ id: SourceType; enabled: boolean }>;
  gemini: { model: string; discovery: boolean } | null;
  quota: { used: number; limit: number; exhaustedUntil?: string } | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed with HTTP ${res.status}`);
  return data as T;
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });

// Your event log: capture and details (stage 1), lineup lookups (stage 2).
export const eventsApi = {
  list: () =>
    request<{ events: LoggedEvent[]; lineups: Record<string, LineupSummary>; editions: Record<string, LineupFacts> }>('/api/events'),
  get: (id: string) =>
    request<{ event: LoggedEvent; job: LookupJob | null; edition: Edition | null; suggestions: ArtistSuggestion[] }>(`/api/events/${id}`),
  create: (text: string) => request<{ event: LoggedEvent }>('/api/events', post({ text })).then((r) => r.event),
  update: (id: string, patch: EventPatch) =>
    request<{ event: LoggedEvent }>(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.event),
  remove: (id: string) => request<unknown>(`/api/events/${id}`, { method: 'DELETE' }),
  research: (id: string) => request<{ event: LoggedEvent }>(`/api/events/${id}/details`, post()).then((r) => r.event),
  weather: (id: string) => request<{ event: LoggedEvent; note?: string }>(`/api/events/${id}/weather`, post()),
  pick: (id: string, candidateId?: string, fields?: EventField[]) =>
    request<{ event: LoggedEvent }>(`/api/events/${id}/details/pick`, post({ candidateId, fields })).then((r) => r.event),
  nameArtists: (id: string) =>
    request<{ suggestions: ArtistSuggestion[] }>(`/api/events/${id}/name-artists`).then((r) => r.suggestions),
  findLineups: (ids: string[]) =>
    request<{ started: string[]; skipped: Array<{ id: string; reason: string }> }>('/api/events/lineups', post({ ids })),
  findLineup: (id: string, lineupUrl?: string) =>
    request<{ event: LoggedEvent; job: LookupJob }>(`/api/events/${id}/lineup`, post({ lineupUrl })),
  cities: (q: string) => request<{ cities: string[] }>(`/api/places/cities?q=${encodeURIComponent(q)}`).then((r) => r.cities),
  cityPoint: (city: string, country?: string) =>
    request<{ point: CityPoint | null }>(
      `/api/places/point?city=${encodeURIComponent(city)}${country ? `&country=${encodeURIComponent(country)}` : ''}`,
    ).then((r) => r.point),
};

// "Check email": whether Gmail is connected and how far your mail was read.
export interface EmailScanStatus {
  configured: boolean;
  connected: boolean;
  account?: string;
  scannedThrough?: string;
  lastCheckedAt?: string;
}

export interface EmailScanStep {
  read: number;
  remaining: number;
  added: number;
  scannedThrough?: string;
  lastCheckedAt?: string;
}

// Ticket emails waiting for your review (stage 1 from email).
export const importsApi = {
  scanStatus: () => request<EmailScanStatus>('/api/imports/scan'),
  scan: () => request<EmailScanStep>('/api/imports/scan', post()),
  list: () => request<{ imports: EmailImport[] }>('/api/imports').then((r) => r.imports),
  add: (ids: string[]) => request<{ events: LoggedEvent[]; imports: EmailImport[] }>('/api/imports/add', post({ ids })),
  skip: (ids: string[], restore = false) =>
    request<{ imports: EmailImport[] }>('/api/imports/skip', post({ ids, restore })).then((r) => r.imports),
};

// "Sync with Google Sheets" in the Table view.
export interface LinkedSheetView {
  id: string;
  title: string;
  tab: string;
  url: string;
  linkedAt: string;
  syncedAt?: string;
}

export interface SheetsStatus {
  configured: boolean;
  connected: boolean;
  account?: string;
  sheet?: LinkedSheetView;
}

export type SheetCellValue = string | number | boolean;

export const sheetsApi = {
  status: () => request<SheetsStatus>('/api/sheets'),
  link: (url: string) => request<{ sheet: LinkedSheetView }>('/api/sheets/link', post({ url })).then((r) => r.sheet),
  create: () => request<{ sheet: LinkedSheetView }>('/api/sheets/link', post({ create: true })).then((r) => r.sheet),
  unlink: () => request<unknown>('/api/sheets/unlink', post()),
  disconnect: () => request<unknown>('/api/sheets/disconnect', post()),
  read: () => request<{ values: SheetCellValue[][]; version: string; sheet: LinkedSheetView }>('/api/sheets/values'),
  write: (rows: Array<Array<string | number | null>>, version: string) =>
    request<{ sheet: LinkedSheetView }>('/api/sheets/values', { method: 'PUT', body: JSON.stringify({ rows, version }) }).then((r) => r.sheet),
};

export const lineupApi = {
  status: () => request<LineupStatus>('/api/lineup/status'),
  retry: (id: string) => request<{ job: LookupJob }>(`/api/lookups/${id}/run`, post()).then((r) => r.job),
  confirm: (id: string, body: ConfirmRequest) =>
    request<{ edition: Edition; event: LoggedEvent | null }>(`/api/lookups/${id}/confirm`, post(body)),
};

export const SOURCE_LABELS: Record<SourceType, string> = {
  clashfinder: 'Clashfinder',
  promoter: 'Promoter',
  wayback: 'Promoter (archived)',
  ticketmaster: 'Ticketmaster',
  setlistfm: 'setlist.fm',
  musicbrainz: 'MusicBrainz',
  discovered: 'Web page',
  email: 'your email',
  user: 'You',
};

export function isActive(status: LookupJob['status'] | undefined): boolean {
  return status === 'queued' || status === 'running';
}
