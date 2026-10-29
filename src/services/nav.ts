// The header's navigation model: which page is open, which section it sits
// in, and how a page is named in the address (?view=table). Pure logic, so the
// header can read it and the rules can be tested without the browser.

export type Section = 'library' | 'explore';
export type Page = 'home' | 'summary' | 'table' | 'manage' | 'timeline' | 'map' | 'stats' | 'artists';
export type SubPage = Exclude<Page, 'home'>;

// Subtabs in the order the strip shows them.
export const SECTIONS: Record<Section, { label: string; pages: SubPage[]; first: SubPage }> = {
  library: { label: 'Library', pages: ['summary', 'table', 'manage'], first: 'summary' },
  explore: { label: 'Explore', pages: ['timeline', 'map', 'stats', 'artists'], first: 'timeline' },
};

const PAGE_SECTION: Record<SubPage, Section> = {
  summary: 'library',
  table: 'library',
  manage: 'library',
  timeline: 'explore',
  map: 'explore',
  stats: 'explore',
  artists: 'explore',
};

export const PAGES: Page[] = ['home', 'summary', 'table', 'manage', 'timeline', 'map', 'stats', 'artists'];

export interface Access {
  canManage: boolean; // members who cannot see Manage get Summary and Table only
}

// The section a page belongs to, or null for Home.
export const sectionOf = (page: Page): Section | null => (page === 'home' ? null : PAGE_SECTION[page]);

// Subtabs a section shows for this viewer.
export const subPagesFor = (section: Section, access: Access): SubPage[] =>
  SECTIONS[section].pages.filter((p) => p !== 'manage' || access.canManage);

// Reads ?view=. Home has no view, and the old ?view=events also lands there.
// A page the viewer cannot see falls back to its section's first page.
export function pageFromView(view: string | null, access: Access): Page {
  if (!view || !PAGES.includes(view as Page)) return 'home';
  const page = view as Page;
  if (page === 'manage' && !access.canManage) return 'summary';
  return page;
}

// The address for a page. Home is the bare address.
export const viewFor = (page: Page): string => (page === 'home' ? '' : `view=${page}`);

// Where a section tab opens. Remembers the subtab last used in that section
// on this device; the first visit opens the section's first page.
export interface NavStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const REMEMBER_KEY = 'liveArchive.subtabs';

function readRemembered(storage: NavStorage | null): Partial<Record<Section, string>> {
  try {
    const raw = storage?.getItem(REMEMBER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Record<Section, string>>) : {};
  } catch {
    return {}; // Blocked or corrupt storage: fall back to the first page.
  }
}

export function rememberedPage(section: Section, access: Access, storage: NavStorage | null): SubPage {
  const page = readRemembered(storage)[section];
  const allowed = subPagesFor(section, access);
  return allowed.find((p) => p === page) ?? SECTIONS[section].first;
}

export function rememberPage(page: SubPage, storage: NavStorage | null): void {
  const section = PAGE_SECTION[page];
  try {
    storage?.setItem(REMEMBER_KEY, JSON.stringify({ ...readRemembered(storage), [section]: page }));
  } catch {
    // Storage full or blocked: the subtab is simply not remembered.
  }
}
