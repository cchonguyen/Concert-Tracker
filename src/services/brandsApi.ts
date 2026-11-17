// Owner-only brand calls for the Brands tab in Global Editions (slice 2.9). Shapes match
// src/server/brands/routes.ts. Errors come back as thrown Error messages from the server's `error` field.

export interface BrandRecord {
  id: string;
  name: string;
  aliases: string[];
  organizationId: string | null;
  seriesCount: number;
  editionCount: number;
}

// One applied change. `undoneAt` is set once it has been undone.
export interface BrandHistoryEntry {
  id: string;
  operation: 'rename' | 'merge' | 'organization';
  brandId: string;
  mergedFromId: string | null;
  undoneAt: string | null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init, headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`);
  return body as T;
}

const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const brandsApi = {
  list: () => call<{ brands: BrandRecord[] }>('/api/manage/brands').then((r) => r.brands),
  rename: (id: string, name: string) =>
    call<BrandHistoryEntry>(`/api/manage/brands/${encodeURIComponent(id)}`, patch({ name })),
  // organizationId null detaches the brand from its organization.
  setOrganization: (id: string, organizationId: string | null) =>
    call<BrandHistoryEntry>(`/api/manage/brands/${encodeURIComponent(id)}/organization`, patch({ organizationId })),
  merge: (sourceId: string, targetId: string) => call<BrandHistoryEntry>('/api/manage/brands/merge', post({ sourceId, targetId })),
  undo: (historyId: string) =>
    call<BrandHistoryEntry>(`/api/manage/brands/history/${encodeURIComponent(historyId)}/undo`, post({})),
};
