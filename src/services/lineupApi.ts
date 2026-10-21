import type { Edition, LookupJob, SourceType } from '../server/lineup/types';
import type { ConfirmRequest } from '../server/lineup/learning';
import type { DetailCandidate, EventField, LineupSummary, LoggedEvent } from '../server/events/types';
import type { EventPatch } from '../server/events/service';
import type { EmailImport } from '../server/events/email/types';
import type { ArtistSuggestion } from '../server/events/artists';
import type { LineupFacts } from '../server/events/scale';

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
  pick: (id: string, candidateId?: string, fields?: EventField[]) =>
    request<{ event: LoggedEvent }>(`/api/events/${id}/details/pick`, post({ candidateId, fields })).then((r) => r.event),
  findLineup: (id: string, lineupUrl?: string) =>
    request<{ event: LoggedEvent; job: LookupJob }>(`/api/events/${id}/lineup`, post({ lineupUrl })),
  cities: (q: string) => request<{ cities: string[] }>(`/api/places/cities?q=${encodeURIComponent(q)}`).then((r) => r.cities),
};

// Ticket emails waiting for your review (stage 1 from email).
export const importsApi = {
  list: () => request<{ imports: EmailImport[] }>('/api/imports').then((r) => r.imports),
  add: (ids: string[]) => request<{ events: LoggedEvent[]; imports: EmailImport[] }>('/api/imports/add', post({ ids })),
  skip: (ids: string[], restore = false) =>
    request<{ imports: EmailImport[] }>('/api/imports/skip', post({ ids, restore })).then((r) => r.imports),
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
