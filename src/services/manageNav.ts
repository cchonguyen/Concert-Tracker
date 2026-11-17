// URL/query parsing and building helpers for Manage navigation (/app?view=manage).
// Supports deep linking into mine vs archive scopes, archive sections,
// canonical editions and artists, and entity inspectors.

import type { NavStorage } from './nav.ts';

export const MANAGE_SCOPES = ['mine', 'archive'] as const;
export type ManageScope = (typeof MANAGE_SCOPES)[number];

export const ARCHIVE_SECTIONS = ['artists', 'series', 'brands', 'editions', 'lookups', 'changes'] as const;
export type ArchiveSection = (typeof ARCHIVE_SECTIONS)[number];

export const EDITION_STATUSES = ['all', 'verified', 'provisional', 'draft'] as const;
export type EditionStatus = (typeof EDITION_STATUSES)[number];

export interface ManageRouteState {
  scope: ManageScope;
  kind?: string;
  id?: string;
  section?: ArchiveSection;
  edition?: string;
  series?: string;
  artist?: string;
  status?: EditionStatus;
  q?: string;
}

export const MANAGE_QUERY_STORAGE_KEY = 'liveArchive.manageQuery';

// Parse query parameters for /app?view=manage
export function parseManageParams(search: string): ManageRouteState {
  const query = search.includes('?') ? search.slice(search.indexOf('?') + 1) : search;
  const params = new URLSearchParams(query);

  const rawScope = params.get('scope');
  const scope: ManageScope = rawScope === 'archive' ? 'archive' : 'mine';

  const rawSection = params.get('section');
  const isValidSection = rawSection !== null && (ARCHIVE_SECTIONS as readonly string[]).includes(rawSection);
  let section: ArchiveSection | undefined;
  if (scope === 'archive') {
    section = isValidSection ? (rawSection as ArchiveSection) : 'editions';
  } else if (isValidSection) {
    section = rawSection as ArchiveSection;
  }

  const rawStatus = params.get('status');
  const status: EditionStatus | undefined =
    rawStatus !== null && (EDITION_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as EditionStatus)
      : undefined;

  const kind = params.get('kind')?.trim() || undefined;
  const id = params.get('id')?.trim() || undefined;
  const edition = params.get('edition')?.trim() || undefined;
  const series = params.get('series')?.trim() || undefined;
  const artist = params.get('artist')?.trim() || undefined;
  const q = params.get('q')?.trim() || undefined;

  const state: ManageRouteState = {
    scope,
    ...(section !== undefined ? { section } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(edition !== undefined ? { edition } : {}),
    ...(series !== undefined ? { series } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(q !== undefined ? { q } : {}),
  };

  return state;
}

// Builds the search string starting with '?view=manage...'
export function buildManageSearch(state: Partial<ManageRouteState> = {}): string {
  const params = new URLSearchParams();
  params.set('view', 'manage');

  if (state.scope === 'archive') {
    params.set('scope', 'archive');
  }

  if (state.kind?.trim()) {
    params.set('kind', state.kind.trim());
  }

  if (state.id?.trim()) {
    params.set('id', state.id.trim());
  }

  if (state.section) {
    params.set('section', state.section);
  }

  if (state.edition?.trim()) {
    params.set('edition', state.edition.trim());
  }

  if (state.series?.trim()) {
    params.set('series', state.series.trim());
  }

  if (state.artist?.trim()) {
    params.set('artist', state.artist.trim());
  }

  if (state.status && state.status !== 'all') {
    params.set('status', state.status);
  }

  if (state.q?.trim()) {
    params.set('q', state.q.trim());
  }

  return `?${params.toString()}`;
}

// Alias for search string starting with ?view=manage
export const buildManageQuery = buildManageSearch;

// Builds full URL e.g. '/app?view=manage...'
export function buildManageUrl(state: Partial<ManageRouteState> = {}, pathname = '/app'): string {
  return `${pathname}${buildManageSearch(state)}`;
}

// Deep link to a canonical shared edition
export function editionUrl(id: string, extra?: Partial<ManageRouteState>): string {
  return buildManageUrl({
    scope: 'archive',
    section: 'editions',
    edition: id,
    ...extra,
  });
}

// Deep link to a canonical series
export function seriesUrl(slug: string, extra?: Partial<ManageRouteState>): string {
  return buildManageUrl({
    scope: 'archive',
    section: 'series',
    series: slug,
    ...extra,
  });
}

// Deep link to a canonical artist
export function canonicalArtistUrl(key: string, extra?: Partial<ManageRouteState>): string {
  return buildManageUrl({
    scope: 'archive',
    section: 'artists',
    artist: key,
    ...extra,
  });
}

// Deep link to a personal/local entity (artist, venue, series)
export function entityUrl(kind: string, id: string, extra?: Partial<ManageRouteState>): string {
  return buildManageUrl({
    kind,
    id,
    ...extra,
  });
}

function defaultStorage(): NavStorage | null {
  try {
    if (typeof window !== 'undefined') {
      return window.sessionStorage ?? window.localStorage ?? null;
    }
  } catch {
    // Storage access blocked or restricted
  }
  return null;
}

export function rememberManageSearch(search: string, storage?: NavStorage | null): void {
  const store = storage !== undefined ? storage : defaultStorage();
  try {
    store?.setItem(MANAGE_QUERY_STORAGE_KEY, search);
  } catch {
    // Storage full or blocked
  }
}

export function rememberedManageSearch(storage?: NavStorage | null): string | null {
  const store = storage !== undefined ? storage : defaultStorage();
  try {
    return store?.getItem(MANAGE_QUERY_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export interface ModifierClickEvent {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  button?: number;
}

// Returns true if click has modifier keys or is not standard primary click
export function isModifiedClick(e: ModifierClickEvent): boolean {
  if (e.button !== undefined && e.button !== 0) return true;
  return Boolean(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
}
