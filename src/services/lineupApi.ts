import type {
  Attendance,
  Edition,
  LookupInput,
  LookupJob,
  SourceType,
} from '../server/lineup/types';
import type { ConfirmRequest } from '../server/lineup/learning';

export type { LookupJob, LookupInput, Edition, ConfirmRequest };

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

export const lineupApi = {
  status: () => request<LineupStatus>('/api/lineup/status'),
  list: () => request<{ jobs: LookupJob[] }>('/api/lookups').then((r) => r.jobs),
  get: (id: string) => request<{ job: LookupJob }>(`/api/lookups/${id}`).then((r) => r.job),
  create: (input: Partial<LookupInput>) =>
    request<{ job: LookupJob }>('/api/lookups', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.job),
  retry: (id: string) => request<{ job: LookupJob }>(`/api/lookups/${id}/run`, { method: 'POST' }).then((r) => r.job),
  confirm: (id: string, body: ConfirmRequest) =>
    request<{ edition: Edition; attendance: Attendance | null }>(`/api/lookups/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export const SOURCE_LABELS: Record<SourceType, string> = {
  clashfinder: 'Clashfinder',
  promoter: 'Promoter',
  wayback: 'Promoter (archived)',
  ticketmaster: 'Ticketmaster',
  setlistfm: 'setlist.fm',
  musicbrainz: 'MusicBrainz',
  discovered: 'Web page',
  user: 'You',
};

export function isActive(job: LookupJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}
