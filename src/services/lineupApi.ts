import type { Edition, LookupJob, SourceType } from '../server/lineup/types';
import type { ShareSettings } from '../server/share/types';
import type { NameIndex } from '../server/entities/link';
import { norm } from './listImport';
import type { Entity, EntityAlias, EntityLink, HistoryEntry, LinkRole } from '../server/entities/types';
import type { ConfirmRequest } from '../server/lineup/learning';
import type { DetailCandidate, EventField, LineupSummary, LoggedEvent } from '../server/events/types';
import type { EventPatch } from '../server/events/service';
import type { EmailImport, MergeField } from '../server/events/email/types';
import type { ArtistSuggestion } from '../server/events/artists';
import type { LineupFacts } from '../server/events/scale';
import type { CityPoint, PlaceGuess } from '../server/events/place';
import type { ArtistGenres, KnownGenre } from '../server/events/genreTypes';
import { dehydrateBody, hydrateEvent, type PeopleBook, type PeopleServer } from './vaultPeople';

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
  PlaceGuess,
};

export interface LineupStatus {
  store: 'file' | 'supabase';
  sources: Array<{ id: SourceType; enabled: boolean }>;
  gemini: { model: string; discovery: boolean } | null;
  quota: { used: number; limit: number; exhaustedUntil?: string } | null;
}

// With a vault on, the people who went travel as encrypted records. While the
// page has the vault, names in outgoing events become person ids and incoming
// events get their names back; without the keys the people are left out and
// the event is marked (see services/vaultPeople.ts). Set by VaultProvider.
let peopleHooks: { book: PeopleBook | null } | null = null;
export const setPeopleHooks = (hooks: { book: PeopleBook | null } | null): void => {
  peopleHooks = hooks;
};

async function outgoing(init?: RequestInit): Promise<RequestInit | undefined> {
  if (!peopleHooks || typeof init?.body !== 'string' || !init.body.includes('"companions"')) return init;
  const body = JSON.parse(init.body);
  for (const holder of [body, body?.patch, body?.event]) {
    if (holder && Array.isArray(holder.companions) && holder.companions.length) Object.assign(holder, await dehydrateBody(holder, peopleHooks.book));
  }
  return { ...init, body: JSON.stringify(body) };
}

function incoming<T>(data: T): T {
  if (!peopleHooks) return data;
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    if (typeof v.id === 'string' && Array.isArray(v.companions) && Array.isArray(v.personIds)) return hydrateEvent(v, peopleHooks!.book);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(data);
}

async function request<T>(url: string, rawInit?: RequestInit): Promise<T> {
  const init = await outgoing(rawInit);
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  // `retry`: the server says to wait a moment and call again.
  // `conflict`: a record that already has the name (Manage), to merge into.
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed with HTTP ${res.status}`), { retry: data.retry === true, conflict: data.conflict });
  }
  return incoming(data) as T;
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
  research: (id: string, useGemini = false) =>
    request<{ event: LoggedEvent }>(`/api/events/${id}/details`, post({ useGemini })).then((r) => r.event),
  weather: (id: string) => request<{ event: LoggedEvent; note?: string }>(`/api/events/${id}/weather`, post()),
  pick: (id: string, candidateId?: string, fields?: EventField[]) =>
    request<{ event: LoggedEvent }>(`/api/events/${id}/details/pick`, post({ candidateId, fields })).then((r) => r.event),
  nameArtists: (id: string) =>
    request<{ suggestions: ArtistSuggestion[] }>(`/api/events/${id}/name-artists`).then((r) => r.suggestions),
  titleArtists: (ids: string[]) =>
    request<{ suggestions: Record<string, ArtistSuggestion[]> }>('/api/events/name-artists', post({ ids })).then((r) => r.suggestions),
  findLineups: (ids: string[]) =>
    request<{ started: string[]; skipped: Array<{ id: string; reason: string }> }>('/api/events/lineups', post({ ids })),
  findLineup: (id: string, lineupUrl?: string) =>
    request<{ event: LoggedEvent; job: LookupJob }>(`/api/events/${id}/lineup`, post({ lineupUrl })),
  cities: (q: string) => request<{ cities: string[] }>(`/api/places/cities?q=${encodeURIComponent(q)}`).then((r) => r.cities),
  placeGuess: (place: { city: string; region?: string; country?: string }) =>
    request<{ guess: PlaceGuess | null; note?: string }>(
      `/api/places/guess?${new URLSearchParams(Object.entries(place).filter((kv): kv is [string, string] => Boolean(kv[1])))}`,
    ),
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
  clientId?: string; // for the browser scan's Google sign-in
  browserCursors?: { streamA?: string; streamB?: string };
}

export interface EmailScanStep {
  read: number;
  skipped: number;
  remaining: number;
  added: number;
  scannedThrough?: string;
  lastCheckedAt?: string;
}

// Ticket emails waiting for your review (stage 1 from email).
export const importsApi = {
  scanStatus: () => request<EmailScanStatus>('/api/imports/scan'),
  scan: () => request<EmailScanStep>('/api/imports/scan', post()),
  // The browser scan's shows; cursors only when the watermark should move.
  proposals: (body: { proposals: unknown[]; messages: unknown[]; updatedCursors?: { streamA?: string; streamB?: string } }) =>
    request<{ changed: number; added: number; cursorsSaved: boolean }>('/api/imports/proposals', post(body)),
  list: () => request<{ imports: EmailImport[] }>('/api/imports').then((r) => r.imports),
  add: (ids: string[]) => request<{ events: LoggedEvent[]; imports: EmailImport[] }>('/api/imports/add', post({ ids })),
  skip: (ids: string[], restore = false) =>
    request<{ imports: EmailImport[] }>('/api/imports/skip', post({ ids, restore })).then((r) => r.imports),
  // "Same as one of mine": fills only the event's empty fields; yours are kept.
  merge: (id: string, eventId: string) =>
    request<{ event: LoggedEvent; import: EmailImport; filled: MergeField[]; kept: Array<{ field: MergeField; yours: string; email: string }> }>(
      '/api/imports/merge',
      post({ id, eventId }),
    ),
  unmerge: (id: string) => request<{ event?: LoggedEvent; import: EmailImport }>('/api/imports/unmerge', post({ id })),
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
  // A member's sheets use the narrow drive.file scope: make a new sheet or
  // choose one in Google's picker (picker is true when the server has its keys).
  member?: boolean;
  picker?: boolean;
  connected: boolean;
  account?: string;
  sheet?: LinkedSheetView;
}

export type SheetCellValue = string | number | boolean;

export const sheetsApi = {
  status: () => request<SheetsStatus>('/api/sheets'),
  link: (url: string) => request<{ sheet: LinkedSheetView }>('/api/sheets/link', post({ url })).then((r) => r.sheet),
  create: () => request<{ sheet: LinkedSheetView }>('/api/sheets/link', post({ create: true })).then((r) => r.sheet),
  linkPicked: (pickedId: string) => request<{ sheet: LinkedSheetView }>('/api/sheets/link', post({ pickedId })).then((r) => r.sheet),
  pickerInfo: () => request<{ accessToken: string; apiKey: string; appId: string }>('/api/sheets/picker'),
  unlink: () => request<unknown>('/api/sheets/unlink', post()),
  disconnect: () => request<unknown>('/api/sheets/disconnect', post()),
  read: () =>
    request<{ values: SheetCellValue[][]; version: string; base?: Array<Array<SheetCellValue | null>>; sheet: LinkedSheetView }>('/api/sheets/values'),
  write: (rows: Array<Array<string | number | null>>, version: string) =>
    request<{ sheet: LinkedSheetView }>('/api/sheets/values', { method: 'PUT', body: JSON.stringify({ rows, version }) }).then((r) => r.sheet),
};

// The share page's link and settings (src/server/share/). The code comes
// back only when a link is made.
export interface ShareLinkView {
  id: string;
  createdAt: string;
  settings: ShareSettings;
}
export const shareApi = {
  status: () => request<{ link: ShareLinkView | null }>('/api/share').then((r) => r.link),
  create: (settings: ShareSettings) => request<{ link: ShareLinkView; code: string }>('/api/share', post({ settings })),
  update: (settings: ShareSettings) =>
    request<{ link: ShareLinkView }>('/api/share/settings', { method: 'PUT', body: JSON.stringify({ settings }) }).then((r) => r.link),
  turnOff: () => request<unknown>('/api/share', { method: 'DELETE' }),
  previewUrl: '/api/share/preview',
};

export interface MemberRow {
  email: string;
  role: 'owner' | 'member';
  joined: boolean;
  invitedAt: string;
}
// Who is signed in, and (owner only, multi-user) the invite list.
export const meApi = {
  get: () => request<{ multiUser: boolean; role: 'owner' | 'member'; email: string | null; noticeAccepted?: boolean }>('/api/me'),
  acceptNotice: () => request<unknown>('/api/me/notice', post()),
};
export const membersApi = {
  list: () => request<{ members: MemberRow[] }>('/api/members').then((r) => r.members),
  invite: (email: string) => request<unknown>('/api/members', post({ email })),
  remove: (email: string) => request<unknown>(`/api/members/${encodeURIComponent(email)}`, { method: 'DELETE' }),
};

import type { VaultMaterial } from './vault';
// The vault's wrapped key material (multi-user). The server never sees a key.
export const vaultApi = {
  get: () => request<{ state: 'plaintext' | 'encrypted'; material: VaultMaterial | null }>('/api/vault'),
  turnOn: (material: VaultMaterial) => request<unknown>('/api/vault', { method: 'PUT', body: JSON.stringify({ material }) }),
  rewrap: (material: VaultMaterial) => request<unknown>('/api/vault/rewrap', post({ material })),
};
export const peopleApi: PeopleServer = {
  list: () => request('/api/people'),
  put: (id, body) => request(`/api/people/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  merge: (id, into) => request(`/api/people/${id}/merge`, post({ into })),
  convert: (id, to) => request(`/api/people/${id}/convert`, post({ to })),
  finish: () => request('/api/people/finish', post()),
};
export const accountApi = {
  exportUrl: '/api/account/export',
  remove: (confirm: string) => request<unknown>('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm }) }),
};

// Genres of the acts you saw: the music-story file, then MusicBrainz on request.
export const genresApi = {
  list: () => request<{ genres: ArtistGenres[]; hasMap: boolean; known: KnownGenre[] }>('/api/artist-genres'),
  setOwn: (key: string, styles: string[]) =>
    request<{ row: ArtistGenres }>(`/api/artist-genres/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ styles }) }).then(
      (r) => r.row,
    ),
  resetOwn: (key: string) =>
    request<unknown>(`/api/artist-genres/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ reset: true }) }),
  importMusicStory: (file: unknown) =>
    request<{ matched: number; seen: number; inFile: number; mapTags: number }>('/api/artist-genres/music-story', post(file)),
  musicBrainz: (keys: string[]) =>
    request<{ genres: ArtistGenres[] }>('/api/artist-genres/musicbrainz', post({ keys })).then((r) => r.genres),
};

// The records behind your events' names (src/server/entities/).
// Manage: the records behind your events' names. Every change returns its
// history entry, which undo takes back.
// Manage with a vault on: a person whose name is encrypted is shown, renamed,
// merged and given AKAs through the people book (the server cannot read the
// name); everything else goes to the server as before.
const TOKEN = /^[0-9a-f]{64}$/;
const vaultPerson = (id: string) => peopleHooks?.book?.get(id);
const noEntry = (operation: HistoryEntry['operation'], summary: string, id: string, eventsChanged = false): HistoryEntry => ({
  id: '',
  operation,
  summary,
  sourceEntityId: id,
  entities: { before: [], after: [] },
  touched: [],
  aliases: { before: [], after: [] },
  links: { before: [], after: [] },
  events: [],
  createdAt: new Date().toISOString(),
  eventsChanged,
});

export function openPeople(data: { entities: Entity[]; aliases: EntityAlias[]; links: EntityLink[]; duplicates: string[][] }) {
  if (!data.entities.some((e) => e.kind === 'person' && e.nameEncrypted)) return data;
  const book = peopleHooks?.book ?? null;
  const entities = data.entities.map((e): Entity => {
    if (e.kind !== 'person' || !e.nameEncrypted) return e;
    const p = book?.get(e.id);
    if (!p) return { ...e, name: 'Locked person', nameNormalized: 'locked person', attrs: {} };
    const { first, last, note } = p.details;
    return { ...e, name: p.name, nameNormalized: norm(p.name), attrs: { ...(first ? { first } : {}), ...(last ? { last } : {}), ...(note ? { note } : {}) } };
  });
  const ids = new Set(entities.filter((e) => e.kind === 'person' && e.nameEncrypted).map((e) => e.id));
  const aliases = data.aliases.filter((a) => !(a.kind === 'person' && TOKEN.test(a.aliasNormalized) && ids.has(a.entityId)));
  for (const id of ids) for (const a of book?.get(id)?.details.aliases ?? []) aliases.push({ entityId: id, kind: 'person', aliasNormalized: norm(a) });
  return { ...data, entities, aliases };
}

const renameOnServer = (id: string, name: string) =>
  request<{ entry: HistoryEntry }>(`/api/entities/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then((r) => r.entry);
const updatePersonOnServer = (id: string, details: { first: string; last?: string; note?: string }) =>
  request<{ entry: HistoryEntry }>(`/api/entities/${id}/person`, { method: 'PATCH', body: JSON.stringify(details) }).then((r) => r.entry);

export const entitiesApi = {
  names: () => request<{ names: NameIndex }>('/api/entities/names').then((r) => r.names),
  list: () => request<{ entities: Entity[]; aliases: EntityAlias[]; links: EntityLink[]; duplicates: string[][] }>('/api/entities').then(openPeople),
  history: () => request<{ history: HistoryEntry[] }>('/api/entities/history').then((r) => r.history),
  // Data health: venues whose events use more than one city, and look-alikes.
  health: () =>
    request<{ venuePlaces: Array<{ venueId: string; places: Array<{ placeId: string; events: number }> }>; duplicates: string[][] }>(
      '/api/entities/health',
    ),
  // Puts venues whose events share one city in it (null: nothing to do).
  linkVenuePlaces: () => request<{ entry: HistoryEntry | null }>('/api/entities/venues/places', post()).then((r) => r.entry),
  undo: (historyId: string) =>
    request<{ entry: HistoryEntry; restored: number; skipped: Array<{ id: string; name: string }> }>(
      `/api/entities/history/${historyId}/undo`,
      post(),
    ),
  createOrganization: (name: string) => request<{ entity: Entity; entry: HistoryEntry }>('/api/entities', post({ kind: 'organization', name })),
  rename: async (id: string, name: string) => {
    const person = vaultPerson(id);
    if (person) {
      await peopleHooks!.book!.rename(id, name);
      return noEntry('rename', `Renamed ${person.name} to ${name.trim()}`, id);
    }
    return renameOnServer(id, name);
  },
  updatePerson: async (id: string, details: { first: string; last?: string; note?: string }) => {
    const person = vaultPerson(id);
    if (!person) return updatePersonOnServer(id, details);
    const book = peopleHooks!.book!;
    const name = [details.first, details.last].map((x) => x?.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
    if (name !== person.name) await book.rename(id, name);
    await book.setDetails(id, { first: details.first.trim(), last: details.last?.trim() || undefined, note: details.note?.trim() || undefined });
    return noEntry('details', `Updated ${name}'s details`, id);
  },
  updateAttrs: (id: string, values: Record<string, string>) =>
    request<{ entry: HistoryEntry }>(`/api/entities/${id}/attrs`, { method: 'PATCH', body: JSON.stringify(values) }).then((r) => r.entry),
  merge: async (id: string, into: string) => {
    const book = peopleHooks?.book;
    if (book?.get(id) && book.get(into)) {
      const [from, target] = [book.get(id)!.name, book.get(into)!.name];
      await book.merge(id, into);
      return noEntry('merge', `Merged ${from} into ${target}`, id, true);
    }
    return request<{ entry: HistoryEntry }>(`/api/entities/${id}/merge`, post({ into })).then((r) => r.entry);
  },
  addAlias: async (id: string, name: string) => {
    const person = vaultPerson(id);
    if (!person) return request<{ entry: HistoryEntry }>(`/api/entities/${id}/aliases`, post({ name })).then((r) => r.entry);
    await peopleHooks!.book!.addAlias(id, name);
    return noEntry('alias-add', `Added "${name.trim()}" as an AKA of ${person.name}`, id);
  },
  removeAlias: async (id: string, name: string) => {
    const person = vaultPerson(id);
    if (!person) return request<{ entry: HistoryEntry }>(`/api/entities/${id}/aliases/remove`, post({ name })).then((r) => r.entry);
    await peopleHooks!.book!.removeAlias(id, name);
    return noEntry('alias-remove', `Removed the AKA "${name.trim()}" from ${person.name}`, id);
  },
  createLabel: (name: string, group?: string) => request<{ entity: Entity; entry: HistoryEntry }>('/api/entities', post({ kind: 'label', name, group })),
  link: (id: string, to: string, role: LinkRole) =>
    request<{ entry: HistoryEntry }>(`/api/entities/${id}/links`, post({ to, role })).then((r) => r.entry),
  unlink: (id: string, to: string, role: LinkRole) =>
    request<{ entry: HistoryEntry }>(`/api/entities/${id}/links/remove`, post({ to, role })).then((r) => r.entry),
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

// Where an event field came from, which also covers the event's venue.
export const FIELD_SOURCE_LABELS: Record<SourceType | 'venue', string> = { ...SOURCE_LABELS, venue: 'its venue' };

export function isActive(status: LookupJob['status'] | undefined): boolean {
  return status === 'queued' || status === 'running';
}
