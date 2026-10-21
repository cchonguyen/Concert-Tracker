import { createHash } from 'node:crypto';

// Your Google Sheet, linked in the Table view ("Sync with Google Sheets").
// You sign in once with the same Google client as Check email, asking only
// for Sheets and your address; the app keeps that refresh token in Supabase
// (app_settings), separate from the Gmail one. It reads and writes only the
// tab you linked. Reviewing what the sheet changed happens in the browser and
// saves through the usual event routes; this file only moves cells.
// See ARCHITECTURE.md ("Google Sheets sync").

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets email';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const SHEETS_SETTING = 'google_sheets';
export const SHEETS_OAUTH_SETTING = 'google_sheets_oauth';

export type SheetValue = string | number | boolean;

export interface LinkedSheet {
  id: string;
  title: string;
  tab: string;
  tabId: number;
  linkedAt: string;
  syncedAt?: string;
}

export interface SheetsSetting {
  refreshToken: string;
  account?: string;
  connectedAt: string;
  sheet?: LinkedSheet;
}

export interface SheetInfo {
  title: string;
  tabs: Array<{ title: string; id: number }>;
}

export interface SheetsApi {
  authUrl(redirectUri: string, state: string): string;
  connect(code: string, redirectUri: string): Promise<{ refreshToken: string; account?: string }>;
  info(refreshToken: string, id: string): Promise<SheetInfo>;
  create(refreshToken: string, title: string, tab: string): Promise<{ id: string; info: SheetInfo }>;
  read(refreshToken: string, id: string, tab: string): Promise<SheetValue[][]>;
  write(refreshToken: string, id: string, tab: string, rows: Array<Array<SheetValue | null>>): Promise<void>;
}

// Google refused the saved sign-in: connect again.
export class SheetsAuthError extends Error {}
// Google refused this request (no access to the sheet, Sheets API off, ...).
export class SheetsError extends Error {}

type Json = Record<string, any>;

export const sheetUrl = (s: Pick<LinkedSheet, 'id' | 'tabId'>) => `https://docs.google.com/spreadsheets/d/${s.id}/edit#gid=${s.tabId}`;

// The spreadsheet id and tab (gid) from a link, or a bare id.
export function parseSheetLink(text: string): { id: string; tabId?: number } | null {
  const s = text.trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
  const id = m?.[1] ?? (/^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : undefined);
  if (!id) return null;
  const gid = /[#?&]gid=(\d+)/.exec(s);
  return { id, tabId: gid ? Number(gid[1]) : undefined };
}

// A1 range for a whole tab: 'Tab name' with quotes doubled.
const tabRange = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

// Fingerprint of what was read, so writing can refuse a sheet that changed
// since you reviewed it.
export function sheetVersion(values: SheetValue[][]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
}

export function createSheets(clientId: string, clientSecret: string): SheetsApi {
  const tokens = new Map<string, { token: string; until: number }>();

  async function json(res: Response, what: string): Promise<Json> {
    const body = (await res.json().catch(() => ({}))) as Json;
    const reason = body.error_description ?? body.error?.message ?? (typeof body.error === 'string' ? body.error : undefined) ?? res.status;
    if (res.status === 401 || (res.status === 400 && (body.error === 'invalid_grant' || body.error === 'invalid_client'))) {
      throw new SheetsAuthError(`Google refused ${what} (${reason}). Sign in to Google Sheets again.`);
    }
    if (res.status === 403) throw new SheetsError(`Google Sheets refused ${what}: ${reason}`);
    if (res.status === 404) throw new SheetsError("That sheet wasn't found. Check the link, and that this Google account can open it.");
    if (!res.ok) throw new SheetsError(`Google Sheets ${what} failed (${reason}).`);
    return body;
  }

  async function token(form: Record<string, string>, what: string): Promise<Json> {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form }),
    });
    return json(res, what);
  }

  async function access(refreshToken: string): Promise<string> {
    const hit = tokens.get(refreshToken);
    if (hit && hit.until > Date.now()) return hit.token;
    const t = await token({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'the saved sign-in');
    tokens.set(refreshToken, { token: t.access_token, until: Date.now() + (Number(t.expires_in ?? 3600) - 60) * 1000 });
    return t.access_token;
  }

  async function call(refreshToken: string, url: string, what: string, init: RequestInit = {}): Promise<Json> {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await access(refreshToken)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    return json(res, what);
  }

  const infoOf = (body: Json): SheetInfo => ({
    title: String(body.properties?.title ?? ''),
    tabs: ((body.sheets as Json[] | undefined) ?? []).map((s) => ({ title: String(s.properties?.title ?? ''), id: Number(s.properties?.sheetId ?? 0) })),
  });

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
      const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'the sign-in');
      if (!t.refresh_token) throw new SheetsAuthError('Google gave no lasting sign-in. Sign in to Google Sheets again.');
      tokens.set(t.refresh_token, { token: t.access_token, until: Date.now() + (Number(t.expires_in ?? 3600) - 60) * 1000 });
      const me = await call(t.refresh_token, USERINFO, 'reading your address').catch(() => ({}) as Json);
      return { refreshToken: t.refresh_token, account: typeof me.email === 'string' ? me.email : undefined };
    },
    async info(refreshToken, id) {
      const q = new URLSearchParams({ fields: 'properties.title,sheets.properties(sheetId,title)' });
      return infoOf(await call(refreshToken, `${API}/${encodeURIComponent(id)}?${q}`, 'opening the sheet'));
    },
    async create(refreshToken, title, tab) {
      const body = await call(refreshToken, API, 'creating a sheet', {
        method: 'POST',
        body: JSON.stringify({
          properties: { title },
          sheets: [{ properties: { title: tab, gridProperties: { frozenRowCount: 1 } } }],
        }),
      });
      return { id: String(body.spreadsheetId), info: infoOf(body) };
    },
    async read(refreshToken, id, tab) {
      // Unformatted, so a date is its serial number whatever the sheet's
      // locale shows; the browser turns serials in date columns back into dates.
      const q = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
      const body = await call(refreshToken, `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tab))}?${q}`, 'reading the sheet');
      return (body.values as SheetValue[][] | undefined) ?? [];
    },
    async write(refreshToken, id, tab, rows) {
      const range = encodeURIComponent(tabRange(tab));
      await call(refreshToken, `${API}/${encodeURIComponent(id)}/values/${range}:clear`, 'clearing the tab', { method: 'POST', body: '{}' });
      // RAW: text stays text, so a name like "1999" or "=)" is not turned into a number or formula.
      const q = new URLSearchParams({ valueInputOption: 'RAW' });
      await call(refreshToken, `${API}/${encodeURIComponent(id)}/values/${range}?${q}`, 'writing the sheet', {
        method: 'PUT',
        body: JSON.stringify({ range: tabRange(tab), majorDimension: 'ROWS', values: rows.map((r) => r.map((v) => v ?? '')) }),
      });
    },
  };
}

export function sheetsFromEnv(): SheetsApi | null {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return id && secret ? createSheets(id, secret) : null;
}
