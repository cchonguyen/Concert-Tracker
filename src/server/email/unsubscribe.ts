import { escapeHtml } from '../share/page';
import type { EmailPreferenceStore } from './store';

// One-click unsubscribe signing, headers (RFC 8058), and the public /unsubscribe
// page answered in frontDoor (src/server/share/door.ts) before Cloudflare Access.
// A recipient may not have a Cloudflare Access session (or may not be a member
// yet), so the link carries an HMAC-SHA256 signature over their lowercase email.

export const UNSUBSCRIBE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

const STYLE = `
:root{color-scheme:light dark;--bg:#0f1115;--card:#181b22;--ink:#eef0f4;--quiet:#a3a9b6;--line:#2a2f3a;--accent:#8b7cf6}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--ink:#14161b;--quiet:#5d6472;--line:#e3e6ec;--accent:#5b4bd6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:480px;margin:0 auto;padding:48px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:22px;margin:0 0 8px}
p{color:var(--quiet);margin:0 0 16px}
.email{color:var(--ink);font-weight:600;word-break:break-all}
button{appearance:none;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:600 14px/1.2 inherit;cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
footer{margin-top:24px;color:var(--quiet);font-size:13px}
footer a{color:var(--accent);text-decoration:none}
`;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function unsubscribeSecretFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.EMAIL_UNSUBSCRIBE_SECRET?.trim() || env.SUPABASE_JWT_SECRET?.trim() || '';
  return secret || null;
}

export async function signUnsubscribe(email: string, secret: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`unsubscribe:${normalized}`));
  return toBase64Url(new Uint8Array(sig));
}

export async function verifyUnsubscribe(email: string, sig: string, secret: string): Promise<boolean> {
  if (!email || !sig || !secret) return false;
  const expected = await signUnsubscribe(email, secret);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

export function unsubscribeUrl(origin: string, email: string, sig: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const normalized = email.trim().toLowerCase();
  return `${cleanOrigin}/unsubscribe?email=${encodeURIComponent(normalized)}&sig=${encodeURIComponent(sig)}`;
}

export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export function renderUnsubscribePage(opts: {
  email?: string;
  optedOut?: boolean;
  actionPath?: string;
  changed?: boolean;
  error?: string;
}): string {
  const title = opts.error ? 'Invalid unsubscribe link' : opts.optedOut ? 'Unsubscribed · LiveArchive' : 'Email preferences · LiveArchive';
  let content: string;
  if (opts.error || !opts.email || !opts.actionPath) {
    content = `<h1>This unsubscribe link isn't valid</h1><p>${escapeHtml(opts.error ?? 'Check the link in your email, or sign in to LiveArchive and open Your account to change your email settings.')}</p>`;
  } else if (opts.optedOut) {
    content = [
      `<h1>You're unsubscribed</h1>`,
      `<p><span class="email">${escapeHtml(opts.email)}</span> will no longer receive emails from LiveArchive.</p>`,
      `<form method="POST" action="${escapeHtml(opts.actionPath)}"><input type="hidden" name="action" value="resubscribe"><button type="submit" class="secondary">Re-subscribe to emails</button></form>`,
    ].join('');
  } else {
    content = [
      `<h1>${opts.changed ? "You're subscribed again" : 'Unsubscribe from LiveArchive emails'}</h1>`,
      `<p>${
        opts.changed
          ? `<span class="email">${escapeHtml(opts.email)}</span> can receive invite and account emails from LiveArchive again.`
          : `Stop sending LiveArchive emails to <span class="email">${escapeHtml(opts.email)}</span>.`
      }</p>`,
      `<form method="POST" action="${escapeHtml(opts.actionPath)}"><input type="hidden" name="action" value="unsubscribe"><button type="submit">Unsubscribe</button></form>`,
    ].join('');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${content}</div><footer><a href="/">LiveArchive</a></footer></main></body></html>`;
}

export interface UnsubscribeDoorDeps {
  prefs: () => Promise<EmailPreferenceStore | null>;
  secret: string | null;
  now?: () => Date;
}

export async function handleUnsubscribeRequest(request: Request, deps: UnsubscribeDoorDeps): Promise<Response> {
  const method = request.method;
  const html = (body: string, status: number) => new Response(method === 'HEAD' ? null : body, { status, headers: UNSUBSCRIBE_HEADERS });

  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return html(renderUnsubscribePage({ error: 'Method not allowed.' }), 405);
  }
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const sig = (url.searchParams.get('sig') ?? '').trim();

  if (!deps.secret || !(await verifyUnsubscribe(email, sig, deps.secret))) {
    return html(renderUnsubscribePage({ error: 'This unsubscribe link is invalid or incomplete.' }), 400);
  }

  let store: EmailPreferenceStore | null = null;
  try {
    store = await deps.prefs();
  } catch (err) {
    console.error('Unsubscribe store failed:', err instanceof Error ? err.message : String(err));
  }
  if (!store) {
    return html(renderUnsubscribePage({ error: 'Email preferences are not available right now. Try again shortly.' }), 503);
  }

  const actionPath = `/unsubscribe?email=${encodeURIComponent(email)}&sig=${encodeURIComponent(sig)}`;

  try {
    if (method === 'POST') {
      const formText = await request.text().catch(() => '');
      const params = new URLSearchParams(formText);
      // RFC 8058 one-click POSTs send "List-Unsubscribe=One-Click"; our HTML form sends action=unsubscribe or action=resubscribe.
      const resubscribe = params.get('action') === 'resubscribe' || url.searchParams.get('action') === 'resubscribe';
      const pref = await store.setEmailOptOut(email, !resubscribe, (deps.now?.() ?? new Date()).toISOString());
      return html(renderUnsubscribePage({ email, optedOut: pref.optedOut, actionPath, changed: true }), 200);
    }

    const pref = await store.getEmailPreference(email);
    return html(renderUnsubscribePage({ email, optedOut: pref.optedOut, actionPath }), 200);
  } catch (err) {
    console.error('Unsubscribe failed:', err instanceof Error ? err.message : String(err));
    return html(renderUnsubscribePage({ error: 'Could not update your email preference right now. Try again shortly.' }), 503);
  }
}
