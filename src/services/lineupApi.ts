import type { Edition, LookupJob, SourceType } from '../server/lineup/types';
import type { ShareSettings } from '../server/share/types';
import type { NameIndex } from '../server/entities/link';
import { norm } from './listImport';
import type { Entity, EntityAlias, EntityLink, HistoryEntry, LinkRole } from '../server/entities/types';
import type { ConfirmRequest } from '../server/lineup/learning';
import type { CanonicalConfirmInput, CanonicalDiff } from '../server/lineup/canonicalIngest';
import type { ArtistAppearance, ArtistChangeImpact, CanonicalArtistRecord, CanonicalEditionSummary, CanonicalOperation } from '../server/entities/canonicalManage';
import type { EditionSuggestion } from '../server/lineup/store/types';
import type { DetailCandidate, EventDetails, EventField, LineupSummary, LoggedEvent } from '../server/events/types';
import type { EventPatch } from '../server/events/service';
import type { ActivityEntry } from '../server/events/activityLog';
import type { EmailImport, MergeField } from '../server/events/email/types';
import type { ArtistSuggestion } from '../server/events/artists';
import type { LineupFacts } from '../server/events/scale';
import type { CityPoint, PlaceGuess } from '../server/events/place';
import type { ArtistGenres, KnownGenre } from '../server/events/genreTypes';
import type { MilestoneSaved, Prefs, TipsSaved } from '../server/auth/prefs';
import { dehydrateBody, hydrateEvent, type PeopleBook, type PeopleServer } from './vaultPeople';
import { allowedInSample, reportBlockedWrite, sampleSource, SAMPLE_WRITE_MESSAGE, SampleRefused, type SampleSource } from './sampleMode';

export type {
  EditionSuggestion,
  LookupJob,
  Edition,
  ConfirmRequest,
  LoggedEvent,
  LineupSummary,
  DetailCandidate,
  EventDetails,
  EventField,
  EventPatch,
  EmailImport,
  ArtistSuggestion,
  LineupFacts,
  PlaceGuess,
};

export interface ReaderCallSummary {
  createdAt: string;
  feature: string;
  provider: string;
  model: string;
  outcome: string;
  reason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estCostUsd: number | null;
}

// Present only when a reader is configured. Spend, caps, log failures and recent are owner only.
export interface ReaderStatus {
  provider: string;
  model: string;
  thinkingLevel: string;
  enabled: boolean;
  breaker: { open: boolean; until?: string; failures: number };
  callsToday: number;
  callsMonth: number;
  spendTodayUsd?: number;
  spendMonthUsd?: number;
  caps?: { dayUsd: number; monthUsd: number; perJob: number; inputChars: number; outputTokens: number };
  logWriteFailuresToday?: number;
  recent?: ReaderCallSummary[];
}

export interface LineupStatus {
  store: 'file' | 'supabase';
  sources: Array<{ id: SourceType; enabled: boolean }>;
  gemini: { model: string; discovery: boolean } | null;
  quota: { used: number; limit: number; exhaustedUntil?: string } | null;
  reader?: ReaderStatus;
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

// In sample mode a call is answered from the sample and never sent to the server,
// except the two request-access calls a stranger may make. A write is refused and
// opens the sample explainer (the top-level fallback; every save control checks first too).
function answerFromSample<T>(sample: SampleSource, method: string, url: string): Promise<T> {
  if (method !== 'GET') {
    reportBlockedWrite();
    return Promise.reject(new SampleRefused(SAMPLE_WRITE_MESSAGE));
  }
  return Promise.resolve().then(() => sample.answer(url) as T);
}

async function request<T>(url: string, rawInit?: RequestInit): Promise<T> {
  const method = (rawInit?.method ?? 'GET').toUpperCase();
  const sample = sampleSource();
  if (sample && !allowedInSample(method, new URL(url, 'http://localhost').pathname)) return answerFromSample<T>(sample, method, url);
  const init = await outgoing(rawInit);
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  // `retry`: the server says to wait a moment and call again.
  // `conflict`: a record that already has the name (Manage), to merge into.
  // `not_invited` (403): the signed-in email has no tracker here; sample mode shows it in the request banner (SampleBanner.tsx).
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed with HTTP ${res.status}`), {
      status: res.status,
      retry: data.retry === true,
      conflict: data.conflict,
      code: data.code,
      email: data.email,
    });
  }
  return incoming(data) as T;
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });

// What the server did about research for an event just created: 'queued' (it is looking), 'pending' (the
// queue could not be reached; the event stays as typed). Absent: the server has no queue, so the browser asks.
const researchOutcome = new Map<string, 'queued' | 'pending'>();
export const takeResearchOutcome = (id: string): 'queued' | 'pending' | undefined => {
  const v = researchOutcome.get(id);
  researchOutcome.delete(id);
  return v;
};

// Your event log: capture and details (stage 1), lineup lookups (stage 2).
export const eventsApi = {
  list: () =>
    request<{ events: LoggedEvent[]; lineups: Record<string, LineupSummary>; editions: Record<string, LineupFacts> }>('/api/events'),
  pollAll: (ids: string[]) =>
    request<{ jobs: LookupJob[]; pendingIds: string[] }>(
      ids.length ? `/api/events/poll?ids=${ids.map(encodeURIComponent).join(',')}` : '/api/events/poll',
    ),
  pollOne: (id: string) =>
    request<{ job: LookupJob | null; detailsStatus?: EventDetails['status'] }>(`/api/events/${encodeURIComponent(id)}/poll`),
  get: (id: string) =>
    request<{ event: LoggedEvent; job: LookupJob | null; edition: Edition | null; suggestions: ArtistSuggestion[] }>(`/api/events/${id}`),
  // research: true (the capture bar) asks the server to research the new event from its queue. The answer is
  // remembered by event id (takeQueuedResearch). Imports leave it off and are never researched.
  create: (text: string, editionId?: string, research = false) =>
    request<{ event: LoggedEvent; research?: 'queued' | 'pending' }>(
      '/api/events',
      post(editionId ? { text, editionId } : research ? { text, research: true } : { text }),
    ).then((r) => {
      if (r.research) researchOutcome.set(r.event.id, r.research);
      return r.event;
    }),
  update: (id: string, patch: EventPatch) =>
    request<{ event: LoggedEvent }>(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.event),
  remove: (id: string) => request<unknown>(`/api/events/${id}`, { method: 'DELETE' }),
  deleted: () => request<{ events: LoggedEvent[] }>('/api/events/deleted').then((r) => r.events),
  restore: (id: string) => request<unknown>(`/api/events/${id}/restore`, post()),
  erase: (id: string) => request<unknown>(`/api/events/${id}/erase`, post()),
  emptyTrash: () => request<{ removed: number }>('/api/events/trash/empty', post()).then((r) => r.removed),
  activity: (limit = 200) => request<{ activity: ActivityEntry[] }>(`/api/activity?limit=${limit}`).then((r) => r.activity),
  // vaultLocked says whether this browser has the vault open; the server refuses sensitive rows while it is locked.
  undo: (id: string, vaultLocked: boolean) => request<unknown>(`/api/activity/${id}/undo`, post({ vaultLocked })),
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
  findLineup: (id: string, lineupUrl?: string, replaceConfirmed?: boolean) =>
    request<{ event: LoggedEvent; job: LookupJob }>(`/api/events/${id}/lineup`, post({ lineupUrl, replaceConfirmed: replaceConfirmed || undefined })),
  lineupVersions: (id: string) =>
    request<{ versions: Array<{ slug: string; name: string; startDate?: string; lastEdit?: string; edits?: number; numActs?: number; url: string }> }>(
      `/api/events/${id}/lineup/versions`,
    ).then((r) => r.versions),
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

// Canonical editions matching the capture line's name (slice 9.1 route). Read-only; the caller handles errors.
export const suggestEditions = (q: string) =>
  request<{ editions: EditionSuggestion[] }>(`/api/editions/suggest?q=${encodeURIComponent(q)}`).then((r) => r.editions);

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
  blocked?: boolean;
  invitedAt: string;
}
// Who is signed in, and (owner only, multi-user) the invite list.
export const meApi = {
  get: () =>
    request<{ multiUser: boolean; role: 'owner' | 'member'; email: string | null; noticeAccepted?: boolean; pendingRequests?: number }>('/api/me'),
  acceptNotice: () => request<unknown>('/api/me/notice', post()),
};

// Home tips and the milestone mark, kept on the account (src/server/auth/prefs.ts).
export const prefsApi = {
  get: () => request<Prefs>('/api/me/prefs'),
  saveTips: (tips: TipsSaved) => request<Prefs>('/api/me/prefs', { method: 'PUT', body: JSON.stringify({ tips }) }),
  saveMilestone: (milestone: Partial<MilestoneSaved>) => request<Prefs>('/api/me/prefs', { method: 'PUT', body: JSON.stringify({ milestone }) }),
};
export interface EmailPrefsView {
  email: string;
  optedOut: boolean;
  optedOutAt: string | null;
  configured: boolean;
}
export const emailPrefsApi = {
  get: () => request<EmailPrefsView>('/api/me/email-prefs'),
  setOptOut: (optedOut: boolean) =>
    request<EmailPrefsView>('/api/me/email-prefs', { method: 'PUT', body: JSON.stringify({ optedOut }) }),
};

export const membersApi = {
  list: () => request<{ members: MemberRow[] }>('/api/members').then((r) => r.members),
  invite: (email: string, opts?: { sendEmail?: boolean; resend?: boolean }) =>
    request<{ ok: boolean; emailSent?: boolean; emailReason?: string }>('/api/members', post({ email, ...opts })),
  // Deletes the member's account and data. The server wants the email again as `confirm`.
  remove: (email: string) => request<unknown>(`/api/members/${encodeURIComponent(email)}`, { method: 'DELETE', body: JSON.stringify({ confirm: email }) }),
};

// Request access (ARCHITECTURE.md "Request access"). The owner's list, settings and status changes.
export type RequestStatus = 'pending' | 'accepted' | 'declined' | 'left';
export interface AccessRequestRow {
  email: string;
  status: RequestStatus;
  source: 'requested' | 'invited' | 'blocked';
  requestedAt: string;
  statusChangedAt: string;
  hasAccount: boolean;
  blocked: boolean;
}
export interface RequestSettings {
  paused: boolean;
  cap: number;
}
export const accessRequestsApi = {
  // A signed-in stranger: their own state, and the ask itself.
  mine: () => request<{ state: 'none' | 'sent' | 'closed' }>('/api/access-requests/mine'),
  ask: () => request<{ state: 'sent' | 'closed' }>('/api/access-requests', post()),
  list: () => request<{ requests: AccessRequestRow[]; settings: RequestSettings; pending: number }>('/api/access-requests'),
  setStatus: (email: string, to: 'pending' | 'accepted' | 'declined', opts?: { sendEmail?: boolean }) =>
    request<{ ok: boolean; emailSent?: boolean; emailReason?: string }>(`/api/access-requests/${encodeURIComponent(email)}`, {
      method: 'PUT',
      body: JSON.stringify({ to, ...opts }),
    }),
  saveSettings: (patch: Partial<RequestSettings>) =>
    request<{ settings: RequestSettings }>('/api/access-requests/settings', { method: 'PUT', body: JSON.stringify(patch) }),
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

export interface CollaborationItem {
  alias: string;
  aliasNormalized: string;
  canonicalName: string;
  partners: string[];
}

export const collaborationsApi = {
  list: () => request<CollaborationItem[]>('/api/collaborations'),
  save: (body: { alias: string; partners: string[]; oldAlias?: string }) =>
    request<{ record: CollaborationItem; entry: HistoryEntry }>('/api/collaborations', post(body)),
  remove: (alias: string) =>
    request<{ entry: HistoryEntry }>(`/api/collaborations/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
};

// Catalog artist change (slice 8.7): one operation, discriminated by `op`. Same shape as the server body.
export type CanonicalArtistOperation =
  | { op: 'rename'; name: string }
  | { op: 'alias-add'; name: string }
  | { op: 'alias-remove'; name: string }
  | { op: 'merge'; into: string };

// Preview reply: the operation, aggregate impact counts and an opaque fingerprint. Nothing is written.
export interface CanonicalArtistPreview {
  operation: CanonicalOperation;
  impact: ArtistChangeImpact;
  previewFingerprint: string;
}

// Apply reply: the applied history entry summary and the community count recomputed at apply time.
export interface CanonicalArtistApplied {
  entry: { id: string; operation: CanonicalOperation; summary: string; at: string };
  communityNameKeysAffected: number | null;
}

// Owner only. Returns counts and a fingerprint; writes nothing.
export const previewCanonicalArtistChange = (key: string, body: CanonicalArtistOperation) =>
  request<CanonicalArtistPreview>(`/api/manage/canonical/artists/${encodeURIComponent(key)}/preview`, post(body));

// Owner only. The server recomputes the plan; previewFingerprint must match the current state or the reply is 409.
export const applyCanonicalArtistChange = (key: string, body: CanonicalArtistOperation, previewFingerprint: string) =>
  request<CanonicalArtistApplied>(`/api/manage/canonical/artists/${encodeURIComponent(key)}/apply`, post({ ...body, previewFingerprint }));

// The Changes list (slice 8.10): canonical operations, newest first, one page per call.
export interface CanonicalChangeRow {
  id: string;
  operation: CanonicalOperation;
  summary: string;
  time: string;
  before: string;
  after: string;
  undoneAt: string | null;
}
export interface CanonicalChangesPage {
  changes: CanonicalChangeRow[];
  // Pass as `cursor` to get the next (older) page. Null on the last page.
  nextCursor: string | null;
  hasMore: boolean;
}
// The server's reply to an Undo. An entity-history entry comes back as `entry`; a file-store canonical change as `id` and `undoneAt`.
export interface HistoryUndoBody {
  entry?: { id?: string; undoneAt?: string };
  id?: string;
  undone?: boolean;
  undoneAt?: string;
  restored?: number;
  skipped?: Array<{ id: string; name: string }>;
}
// An Undo refused with 409 (the records changed after the change, or it was already undone). The message is the server's.
export class UndoConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndoConflictError';
  }
}

// Global Archive (owner only): the shared catalog, not your log.
export const canonicalApi = {
  artists: () => request<{ artists: CanonicalArtistRecord[] }>('/api/manage/canonical/artists'),
  // The ingest queue: jobs with no saved event, newest first.
  lookups: () => request<{ jobs: LookupJob[] }>('/api/manage/canonical/lookups').then((r) => r.jobs),
  editions: (query: string, status: 'all' | 'verified' | 'provisional' | 'draft') =>
    request<{ editions: CanonicalEditionSummary[]; total: number; hasMore: boolean }>(
      `/api/manage/canonical/editions?${new URLSearchParams({ query, status }).toString()}`,
    ),
  edition: (id: string) => request<{ edition: Edition }>(`/api/manage/canonical/editions/${encodeURIComponent(id)}`),
  // Owner only: turn a provisional (member-entered) edition into a verified one. Undo with inboxApi.undo(changeId, id).
  verifyEdition: (id: string) =>
    request<{ ok: boolean; changeId: string | null; edition: { id: string; name: string; status: string } }>(
      `/api/manage/canonical/editions/${encodeURIComponent(id)}/verify`,
      post({}),
    ),
  // Edition facts with a required source note; blank facts are sent as null and stay blank.
  editFacts: (id: string, facts: { name: string; startDate: string | null; endDate: string | null; venue: string | null; city: string | null; sourceNote: string }) =>
    request<{ edition: Edition }>(`/api/manage/canonical/editions/${encodeURIComponent(id)}/facts`, { method: 'PATCH', body: JSON.stringify(facts) }).then((r) => r.edition),
  // Check details for an edition facts draft or stored edition. Owner only.
  researchEdition: (id: string, body?: { name?: string; startDate?: string; endDate?: string; venue?: string; city?: string; useGemini?: boolean }) =>
    request<EventDetails>(`/api/manage/canonical/editions/${encodeURIComponent(id)}/details`, post(body)),
  artist: (key: string) =>
    request<{ artist: CanonicalArtistRecord; appearances: ArtistAppearance[] }>(`/api/manage/canonical/artists/${encodeURIComponent(key)}`),
  // Catalog artists as records (GA3). Each returns the history entry, which Undo (entitiesApi.undo) reverses.
  renameArtist: (key: string, name: string) =>
    request<{ entry: HistoryEntry }>(`/api/manage/canonical/artists/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then((r) => r.entry),
  mergeArtist: (key: string, into: string) =>
    request<{ entry: HistoryEntry }>(`/api/manage/canonical/artists/${encodeURIComponent(key)}/merge`, post({ into })).then((r) => r.entry),
  addArtistAka: (key: string, name: string) =>
    request<{ entry: HistoryEntry }>(`/api/manage/canonical/artists/${encodeURIComponent(key)}/aliases`, post({ name })).then((r) => r.entry),
  removeArtistAka: (key: string, name: string) =>
    request<{ entry: HistoryEntry }>(
      `/api/manage/canonical/artists/${encodeURIComponent(key)}/aliases?name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ).then((r) => r.entry),
  versions: (name: string, year: number) =>
    request<{ versions: Array<{ slug: string; name: string; startDate?: string; lastEdit?: string; edits?: number; numActs?: number; url: string }> }>(
      `/api/manage/canonical/versions?name=${encodeURIComponent(name)}&year=${year}`,
    ).then((r) => r.versions),
  ingest: (body: { name: string; year: number; startDate?: string; endDate?: string; venue?: string; city?: string; country?: string; lineupUrl?: string }) =>
    request<{ job: LookupJob }>('/api/manage/canonical/ingest', post(body)).then((r) => {
      // A reply without a job must not look like success: the caller shows an error.
      if (!r?.job) throw new Error('The lookup was not started. Try again.');
      return r.job;
    }),
  // Owner only. One page of the Changes list; pass the previous nextCursor to get the next page.
  changes: (cursor?: string) =>
    request<CanonicalChangesPage>(`/api/manage/canonical/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  // Undo one history entry (entity history or a file-store canonical change). A 409 throws UndoConflictError with the server's message.
  undoChange: (id: string) =>
    request<HistoryUndoBody>(`/api/entities/history/${encodeURIComponent(id)}/undo`, post()).catch((err: unknown) => {
      if ((err as { status?: number }).status === 409) throw new UndoConflictError(err instanceof Error ? err.message : 'Undo refused.');
      throw err;
    }),
};

// Owner inbox (slice 11.22): the review queue and recent ingest traces. Ids, field names and public edition facts only.
export interface InboxEdition { id: string; name: string; startDate: string | null; endDate: string | null; venue: string | null; city: string | null; country: string | null; status: string }
export interface InboxItem {
  id: string;
  kind: 'override' | 'merge_suggestion' | 'provisional' | 'formatting' | 'failed_lookup';
  status: string;
  editionId?: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  edition: InboxEdition | null;
}
export interface InboxTrace {
  id: string;
  trigger: string;
  eventId: string | null;
  editionId: string | null;
  steps: Array<{ name: string; at: number; detail?: Record<string, string | number | boolean | null> }>;
  subrequests: number | null;
  createdAt: string;
}
export const inboxApi = {
  review: () => request<{ items: InboxItem[] }>('/api/canon/review?status=open').then((r) => r.items),
  traces: (limit = 20) => request<{ traces: InboxTrace[]; tableMissing: boolean }>(`/api/canon/traces?limit=${limit}`),
  promote: (id: string) => request<{ ok: boolean; changeId: string | null }>(`/api/canon/review/${encodeURIComponent(id)}/promote`, post()),
  verify: (id: string) => request<{ ok: boolean; changeId: string | null }>(`/api/canon/review/${encodeURIComponent(id)}/verify`, post()),
  merge: (id: string, keep: string, drop: string) => request<{ ok: boolean }>(`/api/canon/review/${encodeURIComponent(id)}/merge`, post({ keep, drop })),
  dismiss: (id: string) => request<{ ok: boolean }>(`/api/canon/review/${encodeURIComponent(id)}/dismiss`, post()),
  undo: (changeId: string, editionId: string) => request<{ ok: boolean }>(`/api/canon/changes/${encodeURIComponent(changeId)}/undo`, post({ editionId })),
};

export const lineupApi = {
  // Canonical curation (owner only): confirm an edition into the shared catalog.
  canonicalConfirm: (body: CanonicalConfirmInput) =>
    request<{ applied: boolean; diff: CanonicalDiff; edition?: unknown }>('/api/manage/canonical/confirm', post(body)),
  status: () => request<LineupStatus>('/api/lineup/status'),
  retry: (id: string) => request<{ job: LookupJob }>(`/api/lookups/${id}/run`, post()).then((r) => r.job),
  job: (id: string) => request<{ job: LookupJob }>(`/api/lookups/${id}`).then((r) => r.job),
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

// Where an event field came from, which also covers the event's venue and a
// canonical edition (a field copied when you tapped an edition suggestion).
export const FIELD_SOURCE_LABELS: Record<SourceType | 'venue' | 'edition', string> = {
  ...SOURCE_LABELS,
  venue: 'its venue',
  edition: 'the canonical edition',
};

export function isActive(status: LookupJob['status'] | undefined): boolean {
  return status === 'queued' || status === 'running';
}
