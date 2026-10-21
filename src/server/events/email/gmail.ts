import type { RawEmail } from './types';

// Your Gmail, read-only, for "Check email". You connect it once (Google
// sign-in); the app keeps the refresh token in Supabase (app_settings) and
// asks Google for a short-lived access token on each check. It only lists
// and reads messages from the ticket senders that have a reader.
// See ARCHITECTURE.md ("Stage 1 from email").

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_IDS = 500;

export interface GmailMessage extends RawEmail {
  receivedAt: number; // Gmail's internalDate, ms
}

export interface GmailApi {
  authUrl(redirectUri: string, state: string): string;
  // The refresh token and the address it reads.
  connect(code: string, redirectUri: string): Promise<{ refreshToken: string; account?: string }>;
  // Message ids matching a Gmail search, newest first.
  listIds(refreshToken: string, query: string): Promise<string[]>;
  getMessage(refreshToken: string, id: string): Promise<GmailMessage>;
}

export class GmailAuthError extends Error {}

type Json = Record<string, any>;

interface Part {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: Part[];
}

function decode(data: string, charset = 'utf-8'): string {
  const bytes = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// The first text/html and text/plain bodies in the MIME tree.
export function messageBodies(part: Part | undefined): { html?: string; text?: string } {
  const out: { html?: string; text?: string } = {};
  const walk = (p: Part | undefined) => {
    if (!p) return;
    const type = p.mimeType?.toLowerCase() ?? '';
    const charset = p.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value.match(/charset="?([^";]+)/i)?.[1];
    if (p.body?.data && type === 'text/html' && out.html === undefined) out.html = decode(p.body.data, charset);
    if (p.body?.data && type === 'text/plain' && out.text === undefined) out.text = decode(p.body.data, charset);
    p.parts?.forEach(walk);
  };
  walk(part);
  return out;
}

export function toMessage(m: Json, account?: string): GmailMessage {
  const header = (name: string) => (m.payload?.headers as Part['headers'])?.find((h) => h.name.toLowerCase() === name)?.value;
  const receivedAt = Number(m.internalDate);
  const auth = account ? `authuser=${encodeURIComponent(account)}` : 'authuser=0';
  return {
    id: String(m.id),
    link: `https://mail.google.com/mail/?${auth}#all/${m.id}`,
    from: header('from') ?? '',
    sentAt: new Date(receivedAt).toISOString(),
    subject: header('subject') ?? '',
    receivedAt,
    ...messageBodies(m.payload),
  };
}

export function createGmail(clientId: string, clientSecret: string): GmailApi {
  const tokens = new Map<string, { token: string; until: number }>();
  const accounts = new Map<string, string>();

  async function json(res: Response, what: string): Promise<Json> {
    const body = (await res.json().catch(() => ({}))) as Json;
    if (res.status === 400 || res.status === 401) {
      throw new GmailAuthError(`Gmail refused ${what} (${body.error_description ?? body.error?.message ?? body.error ?? res.status}). Connect Gmail again.`);
    }
    if (!res.ok) throw new Error(`Gmail ${what} failed (${res.status}).`);
    return body;
  }

  async function token(refreshToken: string, form: Record<string, string>): Promise<Json> {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form }),
    });
    return json(res, refreshToken ? 'the saved sign-in' : 'the sign-in');
  }

  async function access(refreshToken: string): Promise<string> {
    const hit = tokens.get(refreshToken);
    if (hit && hit.until > Date.now()) return hit.token;
    const t = await token(refreshToken, { grant_type: 'refresh_token', refresh_token: refreshToken });
    tokens.set(refreshToken, { token: t.access_token, until: Date.now() + (Number(t.expires_in ?? 3600) - 60) * 1000 });
    return t.access_token;
  }

  async function get(refreshToken: string, path: string): Promise<Json> {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${await access(refreshToken)}` } });
    return json(res, 'a read');
  }

  async function account(refreshToken: string): Promise<string | undefined> {
    if (!accounts.has(refreshToken)) accounts.set(refreshToken, (await get(refreshToken, '/profile')).emailAddress);
    return accounts.get(refreshToken);
  }

  return {
    authUrl(redirectUri, state) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return `${AUTH}?${q}`;
    },
    async connect(code, redirectUri) {
      const t = await token('', { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      if (!t.refresh_token) throw new GmailAuthError('Google gave no lasting sign-in. Connect Gmail again.');
      return { refreshToken: t.refresh_token, account: await account(t.refresh_token) };
    },
    async listIds(refreshToken, query) {
      const ids: string[] = [];
      let page: string | undefined;
      do {
        const q = new URLSearchParams({ q: query, maxResults: '100', ...(page ? { pageToken: page } : {}) });
        const res = await get(refreshToken, `/messages?${q}`);
        ids.push(...((res.messages as Json[] | undefined) ?? []).map((m) => String(m.id)));
        page = res.nextPageToken;
      } while (page && ids.length < MAX_IDS);
      return ids;
    },
    async getMessage(refreshToken, id) {
      const [m, address] = await Promise.all([get(refreshToken, `/messages/${id}?format=full`), account(refreshToken)]);
      return toMessage(m, address);
    },
  };
}

export function gmailFromEnv(): GmailApi | null {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return id && secret ? createGmail(id, secret) : null;
}
