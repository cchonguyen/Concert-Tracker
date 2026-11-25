// The theme is a per-device choice kept in localStorage: a mode (dark, light or
// follow the system) and an accent. index.html applies it before the app loads
// with the same keys; keep the two in step.

export const THEME_MODES = ['dark', 'light', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

// Each accent is a Tailwind hue that index.css swaps in for violet.
export const ACCENTS = ['violet', 'indigo', 'pink', 'teal', 'orange'] as const;
export type Accent = (typeof ACCENTS)[number];

export const MODE_KEY = 'livearchive.themeMode.v1';
export const ACCENT_KEY = 'livearchive.accent.v1';

export const parseMode = (v: string | null | undefined): ThemeMode =>
  THEME_MODES.includes(v as ThemeMode) ? (v as ThemeMode) : 'dark';

export const parseAccent = (v: string | null | undefined): Accent =>
  ACCENTS.includes(v as Accent) ? (v as Accent) : 'violet';

export const resolveMode = (mode: ThemeMode, systemLight: boolean): 'dark' | 'light' =>
  mode === 'system' ? (systemLight ? 'light' : 'dark') : mode;

// The browser bar color for each resolved mode: the page color (--la-page in index.css).
export const BAR_COLORS = { dark: '#0e0e11', light: '#f7f7f8' } as const;
