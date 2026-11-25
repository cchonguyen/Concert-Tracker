import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { listResolvedEvents } from './inherit';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { eventFromImport, findLogged, mergeImports, mergeIntoEvent, pricesFromImports, readEmails, reviewList, unmergeFromEvent } from './email/imports';
import { GmailApi, GmailAuthError, GmailBusy } from './email/gmail';
import { ticketFactsFor } from './email/ticketFacts';
import { GMAIL_SETTING, GmailSetting, NotConnected, SCAN_SETTING, ScanSetting, scanStep } from './email/scan';
import { EmailImport, RawEmail } from './email/types';
import { BROWSER_SCAN_SETTING, BrowserScanSetting, mergeProposals } from './email/proposals';

// /api/imports: ticket emails in, a review list out, and your ticks back.
// Posting mail needs IMPORT_TOKEN; reviewing works like the rest of the app.
// "Check email" reads your Gmail directly once you connect it (GOOGLE_CLIENT_ID
// and GOOGLE_CLIENT_SECRET set).

const MAX_EMAILS = 100;

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function rawEmails(body: any): RawEmail[] {
  const list = Array.isArray(body?.emails) ? body.emails : null;
  if (!list) throw new InputError('Send { emails: [...] }.');
  if (list.length > MAX_EMAILS) throw new InputError(`Send at most ${MAX_EMAILS} emails at a time.`);
  return list.map((e: any) => {
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const email = {
      id: str(e?.id),
      link: str(e?.link),
      from: str(e?.from),
      sentAt: str(e?.sentAt),
      subject: str(e?.subject) ?? '',
      html: str(e?.html),
      text: str(e?.text),
    };
    if (!email.id || !email.from || !email.sentAt || Number.isNaN(Date.parse(email.sentAt)))
      throw new InputError('Each email needs id, from and sentAt.');
    return { ...email, sentAt: new Date(email.sentAt).toISOString() } as RawEmail;
  });
}

const MAX_PROPOSALS = 5000;
const isoOrUndefined = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

const ids = (body: any): Set<string> => new Set(Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === 'string') : []);

export function importsRouter(deps: PipelineDeps, gmail: GmailApi | null = null): Router {
  const router = Router();
  const fail = (res: any, err: unknown) =>
    res.status(err instanceof InputError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });

  router.post('/imports/email', async (req, res) => {
    const token = process.env.IMPORT_TOKEN;
    if (!token) return res.status(503).json({ error: 'Email import is off: IMPORT_TOKEN is not set.' });
    if (!authorized(req.get('authorization'), token)) return res.status(401).json({ error: 'Wrong import token.' });
    try {
      const { outcomes, ignored } = readEmails(rawEmails(req.body));
      const [existing, events] = await Promise.all([deps.store.listImports(), listResolvedEvents(deps.store)]);
      const changed = mergeImports(existing, outcomes, events, deps.now());
      await deps.store.putImports(changed);
      await deps.store.putEvents(pricesFromImports(changed, events, deps.now()));
      res.json({
        read: outcomes.filter((o) => 'read' in o).length,
        unreadable: outcomes.filter((o) => 'unreadable' in o).length,
        ignored,
        changed: changed.length,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // The browser scan's results ({ proposals, messages, updatedCursors? }).
  // The mail itself never reaches the server: only what was read from it,
  // each value with its quote. Cursors are saved only when sent, so a dry
  // run or a full re-scan can post its shows without moving the watermark.
  router.post('/imports/proposals', async (req, res) => {
    try {
      const proposals = req.body?.proposals;
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      if (!Array.isArray(proposals)) throw new InputError('Send { proposals: [...] }.');
      if (proposals.length > MAX_PROPOSALS) throw new InputError(`Send at most ${MAX_PROPOSALS} proposals at a time.`);
      for (const p of proposals)
        if (typeof p?.seller !== 'string' || !['new', 'flag', 'unreadable', 'skipped'].includes(p?.status) || !Array.isArray(p?.messageLinks) || !Array.isArray(p?.flags))
          throw new InputError('Each proposal needs seller, status, messageLinks and flags.');
      const now = deps.now();
      const [existing, events] = await Promise.all([deps.store.listImports(), listResolvedEvents(deps.store)]);
      const before = new Set(existing.map((r) => r.id));
      const changed = mergeProposals(existing, proposals, messages, events, now);
      await deps.store.putImports(changed);
      await deps.store.putEvents(pricesFromImports(changed, events, now));
      const cursors = req.body?.updatedCursors;
      if (cursors && typeof cursors === 'object') {
        await deps.store.putSetting<BrowserScanSetting>(BROWSER_SCAN_SETTING, {
          streamA: isoOrUndefined(cursors.streamA),
          streamB: isoOrUndefined(cursors.streamB),
          savedAt: now.toISOString(),
        });
      }
      res.json({ changed: changed.length, added: changed.filter((r) => !before.has(r.id) && r.status === 'new').length, cursorsSaved: Boolean(cursors) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/imports', async (_req, res) => {
    try {
      res.json({ imports: reviewList(await deps.store.listImports()) });
    } catch (err) {
      fail(res, err);
    }
  });

  // The ticket facts (seller, order last 4, tickets) of the email an event came from or was merged into.
  router.get('/imports/facts/:eventId', async (req, res) => {
    try {
      res.json({ facts: ticketFactsFor(await deps.store.listImports(), req.params.eventId) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Your ticks: each becomes an event, unless it is already in your log.
  router.post('/imports/add', async (req, res) => {
    try {
      const wanted = ids(req.body);
      const now = deps.now();
      const [rows, events] = await Promise.all([deps.store.listImports(), listResolvedEvents(deps.store)]);
      const added = [];
      const changed: EmailImport[] = [];
      for (const row of rows) {
        if (!wanted.has(row.id) || row.status !== 'new') continue;
        const logged = row.eventId ? events.find((e) => e.id === row.eventId) : findLogged(row, events);
        if (logged) {
          changed.push({ ...row, eventId: logged.id, updatedAt: now.toISOString() });
          continue;
        }
        const event = eventFromImport(row, now);
        added.push(event);
        events.push(event);
        changed.push({ ...row, status: 'added', eventId: event.id, updatedAt: now.toISOString() });
      }
      // Shows already in your log take the email's price when they have none.
      const priced = pricesFromImports(changed, events, now);
      const pricedIds = new Set(priced.map((e) => e.id));
      // One write for all of them (Workers cap subrequests per request).
      await deps.store.putEvents([...added.filter((e) => !pricedIds.has(e.id)), ...priced]);
      await deps.store.putImports(changed);
      res.json({ events: added, imports: changed });
    } catch (err) {
      fail(res, err);
    }
  });

  // "Same as one of mine" ({ id, eventId }): the email's show is merged into
  // an event you entered. Only its empty fields are filled; yours are kept.
  router.post('/imports/merge', async (req, res) => {
    try {
      const now = deps.now();
      const [rows, events] = await Promise.all([deps.store.listImports(), listResolvedEvents(deps.store)]);
      const row = rows.find((r) => r.id === req.body?.id);
      const event = events.find((e) => e.id === req.body?.eventId);
      if (!row || row.status !== 'new') throw new InputError('That email is not waiting for review.');
      if (!event) throw new InputError('That event is not in your log.');
      const result = mergeIntoEvent(row, event, now);
      const merged: EmailImport = { ...row, status: 'added', eventId: event.id, mergedFields: result.filled, updatedAt: now.toISOString() };
      if (result.filled.length) await deps.store.putEvents([result.event]);
      await deps.store.putImports([merged]);
      res.json({ event: result.event, import: merged, filled: result.filled, kept: result.kept });
    } catch (err) {
      fail(res, err);
    }
  });

  // Undo a merge ({ id }): the fields it filled are cleared unless you changed them since.
  router.post('/imports/unmerge', async (req, res) => {
    try {
      const now = deps.now();
      const [rows, events] = await Promise.all([deps.store.listImports(), listResolvedEvents(deps.store)]);
      const row = rows.find((r) => r.id === req.body?.id);
      if (!row || row.status !== 'added' || !row.mergedFields) throw new InputError('That email was not merged into an event.');
      const event = events.find((e) => e.id === row.eventId);
      const restored = event ? unmergeFromEvent(row, event, now) : undefined;
      if (restored && restored !== event) await deps.store.putEvents([restored]);
      const back: EmailImport = { ...row, status: 'new', eventId: undefined, mergedFields: undefined, updatedAt: now.toISOString() };
      await deps.store.putImports([back]);
      res.json({ event: restored, import: back });
    } catch (err) {
      fail(res, err);
    }
  });

  // "Leave these out" ({ ids }): not attended, or not a show at all; or back to the list ({ ids, restore: true }).
  router.post('/imports/skip', async (req, res) => {
    try {
      const wanted = ids(req.body);
      const restore = req.body?.restore === true;
      const now = deps.now().toISOString();
      const changed = (await deps.store.listImports())
        .filter((r) => wanted.has(r.id) && r.status === (restore ? 'skipped' : 'new'))
        .map((r) => ({ ...r, status: restore ? ('new' as const) : ('skipped' as const), updatedAt: now }));
      await deps.store.putImports(changed);
      res.json({ imports: changed });
    } catch (err) {
      fail(res, err);
    }
  });

  // Check email: whether Gmail is connected and how far your mail was read.
  router.get('/imports/scan', async (_req, res) => {
    try {
      if (!gmail) return res.json({ configured: false, connected: false });
      const [login, scan, browser] = await Promise.all([
        deps.store.getSetting<GmailSetting>(GMAIL_SETTING),
        deps.store.getSetting<ScanSetting>(SCAN_SETTING),
        deps.store.getSetting<BrowserScanSetting>(BROWSER_SCAN_SETTING),
      ]);
      res.json({
        configured: true,
        // Public by design: the browser scan's Google sign-in needs it.
        clientId: process.env.GOOGLE_CLIENT_ID,
        browserCursors: browser ? { streamA: browser.streamA, streamB: browser.streamB } : undefined,
        connected: Boolean(login),
        account: login?.account,
        scannedThrough: scan?.scannedThrough,
        lastCheckedAt: scan?.lastCheckedAt,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // One step of a check; the page calls again while `remaining` is above 0.
  router.post('/imports/scan', async (_req, res) => {
    if (!gmail) return res.status(503).json({ error: 'Check email is off: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.' });
    try {
      res.json(await scanStep(deps.store, gmail, deps.now()));
    } catch (err) {
      if (err instanceof NotConnected || err instanceof GmailAuthError) return res.status(409).json({ error: err.message, connect: true });
      // What was left to read is kept; the page waits and calls again.
      if (err instanceof GmailBusy) return res.status(429).json({ error: err.message, retry: true });
      fail(res, err);
    }
  });

  // Connect Gmail: Google's sign-in, then back to /api/gmail/callback.
  const callbackUrl = (req: any) => `${process.env.APP_URL || `${req.protocol}://${req.get('host')}`}/api/gmail/callback`;
  const OAUTH_SETTING = 'gmail_oauth';

  router.get('/gmail/connect', async (req, res) => {
    if (!gmail) return res.status(503).send('Check email is off: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.');
    try {
      const state = randomUUID();
      await deps.store.putSetting(OAUTH_SETTING, { state, until: deps.now().getTime() + 10 * 60_000 });
      res.redirect(gmail.authUrl(callbackUrl(req), state));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/gmail/callback', async (req, res) => {
    const back = (result: string) => res.redirect(`/app?gmail=${encodeURIComponent(result)}`);
    if (!gmail) return back('Check email is off.');
    try {
      const pending = await deps.store.getSetting<{ state: string; until: number }>(OAUTH_SETTING);
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!pending || pending.state !== state || pending.until < deps.now().getTime()) return back('That sign-in expired. Try Connect Gmail again.');
      await deps.store.putSetting(OAUTH_SETTING, { state: '', until: 0 });
      if (!code) return back('Gmail was not connected.');
      const login = await gmail.connect(code, callbackUrl(req));
      await deps.store.putSetting<GmailSetting>(GMAIL_SETTING, { ...login, connectedAt: deps.now().toISOString() });
      back('connected');
    } catch (err) {
      back(err instanceof Error ? err.message : String(err));
    }
  });

  return router;
}
