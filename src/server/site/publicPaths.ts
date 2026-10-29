// The public part of the site: pages and files anyone can open without
// signing in. Everything else is the app (/app) or the API (/api), and needs
// a Cloudflare Access token once ACCESS_TEAM_DOMAIN and ACCESS_AUD are set.
// The same list goes into the Access bypass policy (ARCHITECTURE.md, Public
// pages); tests/publicPages.test.ts checks that this list and the document
// agree.

export const PUBLIC_EXACT_PATHS: readonly string[] = [
  '/',
  '/index.html',
  '/demo',
  '/privacy',
  '/privacy.html',
  '/terms',
  '/terms.html',
  '/robots.txt',
  '/sitemap.xml',
  '/og.png',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

// Prefixes: built JavaScript and CSS (code, never data), the demo's pages,
// and the share page (/s/<code>; its own door checks the code).
export const PUBLIC_PREFIXES: readonly string[] = ['/assets/', '/demo/', '/s/', '/S/'];

export const isPublicPath = (path: string): boolean =>
  PUBLIC_EXACT_PATHS.includes(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));

// Old bookmarks and Google's return addresses that pointed at the app when it
// lived at "/". The app is at /app now, with the same query string.
const OLD_APP_PARAMS = ['view', 'gmail', 'sheets'];

export function oldAppLink(url: URL): string | null {
  if (url.pathname !== '/') return null;
  if (!OLD_APP_PARAMS.some((key) => url.searchParams.has(key))) return null;
  return `/app${url.search}`;
}
