import type { ShareEvent, ShareView } from './types';

// The share page as plain HTML with inline styles and no scripts. It is
// rendered from a ShareView alone (never from an event), and every value is
// escaped.

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Sent with the page and the "not active" page alike.
export const SHARE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

const STYLE = `
:root{color-scheme:light dark;--bg:#0e0e11;--card:#141418;--ink:#ededf0;--quiet:#a1a1aa;--line:#2a2a31;--line-strong:#3d3d46;--accent:#c4b5fd;--accent-fill:#a78bfa}
@media (prefers-color-scheme:light){:root{--bg:#f7f7f8;--card:#ffffff;--ink:#18181b;--quiet:#52525b;--line:#e4e4e7;--line-strong:#c4c4cc;--accent:#6d28d9;--accent-fill:#7c3aed}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 'Plus Jakarta Sans',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1,h2{font-family:'Newsreader',Georgia,serif;font-weight:400;letter-spacing:-0.015em}
h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:32px 0 12px}h3{font-size:16px;font-weight:800;margin:20px 0 8px;color:var(--ink)}
.sub{color:var(--quiet);margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px}
.tile{background:var(--card);border:1px solid var(--line-strong);border-radius:12px;padding:10px 12px}
.tile b{display:block;font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}.tile span{color:var(--quiet);font-size:13px}
ol,ul{margin:0;padding:0;list-style:none}
.rank li,.cities li,.series li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.n{color:var(--quiet);white-space:nowrap;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-variant-numeric:tabular-nums}
.ev{background:var(--card);border:1px solid var(--line-strong);border-left:3px solid var(--accent-fill);border-radius:0;padding:10px 12px;margin:0}
.ev+.ev{border-top:0}
.ev .t{font-weight:600}.ev .m{color:var(--quiet);font-size:12.5px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}.ev .a{font-size:14px;margin-top:4px}
.kind{font-size:11px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);margin-left:6px}
nav{display:flex;flex-wrap:wrap;gap:6px 12px;margin:8px 0 0}nav a{color:var(--accent);text-decoration:none;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
footer{margin-top:40px;color:var(--quiet);font-size:13px}
`;

const doc = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function eventHtml(e: ShareEvent): string {
  const meta = [e.when, e.venue, [e.city, e.country].filter(Boolean).join(', '), e.formats?.join(', ')].filter(Boolean) as string[];
  return `<li class="ev"><div class="t">${escapeHtml(e.title)}${e.kind ? `<span class="kind">${e.kind === 'festival' ? 'Festival' : 'Concert'}</span>` : ''}</div>${
    meta.length ? `<div class="m">${meta.map(escapeHtml).join(' · ')}</div>` : ''
  }${e.acts.length ? `<div class="a">${e.acts.map(escapeHtml).join(', ')}</div>` : ''}</li>`;
}

export function renderSharePage(v: ShareView): string {
  const t = v.totals;
  const name = escapeHtml(v.displayName);
  const span = t.firstYear && t.lastYear ? (t.firstYear === t.lastYear ? `${t.firstYear}` : `${t.firstYear} to ${t.lastYear}`) : '';
  const tile = (n: number, label: string) => `<div class="tile"><b>${n}</b><span>${escapeHtml(label)}</span></div>`;
  const parts: string[] = [
    `<h1>${name}'s concerts</h1><p class="sub">${escapeHtml([plural(t.events, 'event'), span].filter(Boolean).join(', '))}</p>`,
    `<div class="tiles">${[
      tile(t.events, 'events'),
      tile(t.festivals, 'festivals'),
      tile(t.concerts, 'concerts'),
      tile(t.acts, 'acts seen'),
      tile(t.cities, 'cities'),
      tile(t.countries, 'countries'),
    ].join('')}</div>`,
  ];
  if (v.mostSeen.length)
    parts.push(
      `<h2>Most seen</h2><ol class="rank">${v.mostSeen.map((r) => `<li><span>${escapeHtml(r.name)}</span><span class="n">${plural(r.count, 'time')}</span></li>`).join('')}</ol>`,
    );
  if (v.series.length)
    parts.push(
      `<h2>Back again</h2><ul class="series">${v.series.map((s) => `<li><span>${escapeHtml(s.name)}</span><span class="n">${s.years.join(', ')}</span></li>`).join('')}</ul>`,
    );
  if (v.years.length) {
    parts.push(`<h2>By year</h2><nav>${v.years.map((y) => `<a href="#y${y.year}">${y.year}</a>`).join('')}</nav>`);
    for (const y of v.years) parts.push(`<h3 id="y${y.year}">${y.year} · ${plural(y.events.length, 'event')}</h3><ol>${y.events.map(eventHtml).join('')}</ol>`);
  }
  if (v.cities.length)
    parts.push(
      `<h2>Cities</h2><p class="sub">${escapeHtml(`${plural(t.cities, 'city', 'cities')}, ${plural(t.states, 'state')}, ${plural(t.countries, 'country', 'countries')}`)}</p><ul class="cities">${v.cities
        .map((c) => `<li><span>${escapeHtml(c.name)}</span><span class="n">${plural(c.count, 'event')}</span></li>`)
        .join('')}</ul>`,
    );
  if (!t.events) parts.push('<p class="sub">No events to show yet.</p>');
  parts.push('<footer>Shared from Concert Tracker. This page is read-only.</footer>');
  return doc(`${v.displayName}'s concerts`, parts.join(''));
}

// The same page for a wrong, unknown or turned-off link.
export const NOT_ACTIVE_HTML = doc('Link not active', '<h1>This link isn\'t active</h1><p class="sub">Ask the person who shared it for a new link.</p>');
export const UNAVAILABLE_HTML = doc('Not available', '<h1>This page isn\'t available right now</h1><p class="sub">Try again in a little while.</p>');
