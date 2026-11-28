// The theme is a per-device choice kept in localStorage: a mode (dark, light or
// follow the system) and an accent. app.html applies it before the app loads
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

// The browser bar color for each resolved mode: the page color (--la-page in src/styles/tokens.css).
export const BAR_COLORS = { dark: '#0e0e11', light: '#f7f7f8' } as const;

// Ticket stub style: how every ticket stub is printed.
// src/styles/ticket-styles.css restyles .ticket-card for each value of data-stub on <html>.
export const STUB_STYLES = ['original', 'thermal', 'hard', 'raffle', 'riso'] as const;
export type StubStyle = (typeof STUB_STYLES)[number];
export const STUB_STYLE_LABELS: Record<StubStyle, string> = {
  original: 'Original',
  thermal: 'Box office',
  hard: 'Hard ticket',
  raffle: 'Raffle',
  riso: 'Riso',
};
export const STUB_STYLE_KEY = 'livearchive.stubStyle.v1';

export const parseStubStyle = (v: string | null | undefined): StubStyle =>
  STUB_STYLES.includes(v as StubStyle) ? (v as StubStyle) : 'original';
