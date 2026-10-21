import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import {
  LinkedSheet,
  parseSheetLink,
  SHEETS_BASE_SETTING,
  SHEETS_OAUTH_SETTING,
  SHEETS_SETTING,
  SheetsApi,
  SheetsAuthError,
  SheetsBase,
  SheetsError,
  SheetsSetting,
  SheetValue,
  sheetUrl,
  sheetVersion,
} from './sheets';

// /api/sheets: sign in to Google Sheets, link a sheet, read it and write it.
// Signing in comes back through /api/gmail/callback, the address already
// registered with Google for Check email, and is told apart by its state.

const MAX_ROWS = 5000;
const MAX_COLS = 40;
const NEW_TAB = 'Events';

const linkView = (s: LinkedSheet) => ({ ...s, url: sheetUrl(s) });

function rowsOf(body: any): Array<Array<SheetValue | null>> {
  const rows = body?.rows;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS + 1) throw new InputError(`Send { rows } with at most ${MAX_ROWS} events.`);
  return rows.map((r: unknown) => {
    if (!Array.isArray(r) || r.length > MAX_COLS) throw new InputError(`Each row is a list of at most ${MAX_COLS} cells.`);
    return r.map((v) => (v === null || v === undefined ? null : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v)));
  });
}

export function sheetsRouter(deps: PipelineDeps, sheets: SheetsApi | null): Router {
  const router = Router();
  const off = 'Google Sheets sync is off: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.';
  const fail = (res: any, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SheetsAuthError) return res.status(409).json({ error: message, connect: true });
    res.status(err instanceof InputError || err instanceof SheetsError ? 400 : 500).json({ error: message });
  };
  const setting = () => deps.store.getSetting<SheetsSetting>(SHEETS_SETTING);
  const signedIn = async () => {
    const s = await setting();
    if (!s?.refreshToken) throw new SheetsAuthError('Sign in to Google Sheets first.');
    return s;
  };
  const linked = async () => {
    const s = await signedIn();
    if (!s.sheet) throw new InputError('Link a sheet first.');
    return s as SheetsSetting & { sheet: LinkedSheet };
  };

  router.get('/sheets', async (_req, res) => {
    if (!sheets) return res.json({ configured: false, connected: false });
    try {
      const s = await setting();
      res.json({
        configured: true,
        connected: Boolean(s?.refreshToken),
        account: s?.account,
        sheet: s?.refreshToken && s.sheet ? linkView(s.sheet) : undefined,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  const callbackUrl = (req: any) => `${process.env.APP_URL || `${req.protocol}://${req.get('host')}`}/api/gmail/callback`;

  router.get('/sheets/connect', async (req, res) => {
    if (!sheets) return res.status(503).send(off);
    try {
      const state = `sheets-${randomUUID()}`;
      await deps.store.putSetting(SHEETS_OAUTH_SETTING, { state, until: deps.now().getTime() + 10 * 60_000 });
      res.redirect(sheets.authUrl(callbackUrl(req), state));
    } catch (err) {
      fail(res, err);
    }
  });

  // Ours when the state starts with "sheets-"; anything else is Gmail's.
  router.get('/gmail/callback', async (req, res, next) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state.startsWith('sheets-')) return next();
    const back = (result: string) => res.redirect(`/?view=table&sheets=${encodeURIComponent(result)}`);
    if (!sheets) return back('Google Sheets sync is off.');
    try {
      const pending = await deps.store.getSetting<{ state: string; until: number }>(SHEETS_OAUTH_SETTING);
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!pending || pending.state !== state || pending.until < deps.now().getTime()) return back('That sign-in expired. Try again.');
      await deps.store.putSetting(SHEETS_OAUTH_SETTING, { state: '', until: 0 });
      if (!code) return back('Google Sheets was not connected.');
      const login = await sheets.connect(code, callbackUrl(req));
      const before = await setting();
      // A new sign-in keeps the linked sheet, unless it is another account.
      const keep = before?.sheet && (!before.account || before.account === login.account) ? before.sheet : undefined;
      await deps.store.putSetting<SheetsSetting>(SHEETS_SETTING, { ...login, connectedAt: deps.now().toISOString(), sheet: keep });
      back('connected');
    } catch (err) {
      back(err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/sheets/disconnect', async (_req, res) => {
    try {
      // app_settings.data cannot be null: an empty setting is signed out.
      await deps.store.putSetting<Partial<SheetsSetting>>(SHEETS_SETTING, {});
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Link a sheet you already have ({ url }), or make a new one ({ create: true }).
  router.post('/sheets/link', async (req, res) => {
    if (!sheets) return res.status(503).json({ error: off });
    try {
      const s = await signedIn();
      let sheet: LinkedSheet;
      if (req.body?.create) {
        const made = await sheets.create(s.refreshToken, 'LiveArchive events', NEW_TAB);
        const tab = made.info.tabs[0] ?? { title: NEW_TAB, id: 0 };
        sheet = { id: made.id, title: made.info.title, tab: tab.title, tabId: tab.id, linkedAt: deps.now().toISOString() };
      } else {
        const link = parseSheetLink(String(req.body?.url ?? ''));
        if (!link) throw new InputError('Paste the link to a Google Sheet (it contains /spreadsheets/d/...).');
        const info = await sheets.info(s.refreshToken, link.id);
        const tab = info.tabs.find((t) => t.id === link.tabId) ?? info.tabs[0];
        if (!tab) throw new InputError('That sheet has no tabs.');
        sheet = { id: link.id, title: info.title, tab: tab.title, tabId: tab.id, linkedAt: deps.now().toISOString() };
      }
      await deps.store.putSetting<SheetsSetting>(SHEETS_SETTING, { ...s, sheet });
      res.json({ sheet: linkView(sheet) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/sheets/unlink', async (_req, res) => {
    try {
      const s = await signedIn();
      await deps.store.putSetting<SheetsSetting>(SHEETS_SETTING, { ...s, sheet: undefined });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // The linked tab's cells, and a version to send back when writing.
  router.get('/sheets/values', async (_req, res) => {
    if (!sheets) return res.status(503).json({ error: off });
    try {
      const s = await linked();
      const [values, saved] = await Promise.all([
        sheets.read(s.refreshToken, s.sheet.id, s.sheet.tab),
        deps.store.getSetting<SheetsBase>(SHEETS_BASE_SETTING),
      ]);
      // The base only counts for the tab it was written to.
      const base = saved?.rows && saved.id === s.sheet.id && saved.tab === s.sheet.tab ? saved.rows : undefined;
      res.json({ values, version: sheetVersion(values), base, sheet: linkView(s.sheet) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Replace the tab with { rows } (header first), and keep them as the base
  // for the next sync. Refused with 409 when the tab changed since it was
  // read at { version }.
  router.put('/sheets/values', async (req, res) => {
    if (!sheets) return res.status(503).json({ error: off });
    try {
      const s = await linked();
      const rows = rowsOf(req.body);
      const version = typeof req.body?.version === 'string' ? req.body.version : '';
      const now = await sheets.read(s.refreshToken, s.sheet.id, s.sheet.tab);
      if (sheetVersion(now) !== version) {
        return res.status(409).json({ error: 'The sheet changed while you were reviewing it. Sync again to pick up the new edits.', changed: true });
      }
      await sheets.write(s.refreshToken, s.sheet.id, s.sheet.tab, rows);
      await deps.store.putSetting<SheetsBase>(SHEETS_BASE_SETTING, { id: s.sheet.id, tab: s.sheet.tab, rows });
      const sheet = { ...s.sheet, syncedAt: deps.now().toISOString() };
      await deps.store.putSetting<SheetsSetting>(SHEETS_SETTING, { ...s, sheet });
      res.json({ sheet: linkView(sheet) });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
