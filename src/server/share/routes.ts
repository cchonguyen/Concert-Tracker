import { Router } from 'express';
import type { PipelineDeps } from '../lineup/pipeline';
import { activeLink, createShareLink, readShareSettings, revokeShareLinks, ShareSettingsError, updateShareSettings } from './links';
import { SHARE_HEADERS } from './page';
import { sharePageHtml } from './door';
import type { ShareLink } from './types';

// /api/share: the owner's controls for the share page, behind Cloudflare
// Access like the rest of /api. The link's code is returned once, when the
// link is made, and never stored; the preview renders the active link's page
// through the same code as /s/<code>.

const linkView = (l: ShareLink) => ({ id: l.id, createdAt: l.createdAt, settings: l.settings });

export function shareRouter(deps: PipelineDeps): Router {
  const router = Router();
  const fail = (res: any, err: unknown) =>
    res.status(err instanceof ShareSettingsError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });

  router.get('/share', async (_req, res) => {
    try {
      const link = activeLink(await deps.store.listShareLinks());
      res.json({ link: link ? linkView(link) : null });
    } catch (err) {
      fail(res, err);
    }
  });

  // Makes a new link and turns off the old one.
  router.post('/share', async (req, res) => {
    try {
      const { link, code } = await createShareLink(deps.store, readShareSettings(req.body?.settings), deps.now());
      res.json({ link: linkView(link), code });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/share/settings', async (req, res) => {
    try {
      const link = await updateShareSettings(deps.store, readShareSettings(req.body?.settings));
      if (!link) return res.status(404).json({ error: 'There is no active link. Make one first.' });
      res.json({ link: linkView(link) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/share', async (_req, res) => {
    try {
      await revokeShareLinks(deps.store, deps.now());
      res.json({ link: null });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/share/preview', async (_req, res) => {
    try {
      const link = activeLink(await deps.store.listShareLinks());
      if (!link) return res.status(404).json({ error: 'There is no active link.' });
      res.set(SHARE_HEADERS).send(await sharePageHtml(deps.store, link.settings, deps.now()));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
