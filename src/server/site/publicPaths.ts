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
  '/unsubscribe',
  '/robots.txt',
  '/sitemap.xml',
  '/og.png',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/logo.svg',
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

// The site's address, for canonical links, the sitemap and robots.txt. The
// same value is in site.config.json (Vite fills the HTML from that file) and
// must equal APP_URL in wrangler.jsonc; tests/publicPages.test.ts checks both.
export const SITE_ORIGIN = 'https://concert.charliechonguyen.com';

// The public pages a search engine may index. The share page is not listed.
export const SITEMAP_PATHS = ['/', '/demo', '/privacy', '/terms'];

export const robotsTxt = (origin: string): string =>
  [
    'User-agent: *',
    'Allow: /',
    'Allow: /demo',
    'Allow: /privacy',
    'Allow: /terms',
    'Disallow: /app',
    'Disallow: /api/',
    'Disallow: /s/',
    'Disallow: /unsubscribe',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');

export const sitemapXml = (origin: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...SITEMAP_PATHS.map((path) => `  <url><loc>${origin}${path}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
