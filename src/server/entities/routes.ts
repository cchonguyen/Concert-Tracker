import { Response, Router } from 'express';
import { PipelineDeps } from '../lineup/pipeline';
import { isLinking } from './linkingStore';
import { nameIndex, possibleDuplicates } from './link';
import { EntityIntegrityError } from './integrity';
import { EditionStatusFilter, listCanonicalEditions } from './canonicalManage';
import { currentMember } from '../auth/requestScope';
import {
  addAlias,
  addLink,
  createEntity,
  linkVenuePlaces,
  ManageError,
  mergeEntity,
  removeAlias,
  removeLink,
  renameEntity,
  updateAttrs,
  updatePerson,
  undoEntry,
  venuePlaceConflicts,
} from './manage';

// /api/entities: the records behind your events' names (0014).
export function entitiesRouter(deps: PipelineDeps): Router {
  const router = Router();

  // Artist and person names and aliases to their record, so the list import
  // can tell that "Joel Zimmerman" is already on an event as "deadmau5".
  // Empty without the entity tables.
  router.get('/entities/names', async (_req, res) => {
    try {
      if (!isLinking(deps.store)) return res.json({ names: {} });
      const [entities, aliases] = await Promise.all([deps.store.listEntities(), deps.store.listEntityAliases()]);
      res.json({ names: nameIndex(entities, aliases, ['artist', 'person']) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Everything below needs the entity tables (migration 0014).
  const manage =
    (fn: (req: any) => Promise<unknown>) =>
    async (req: any, res: Response) => {
      try {
        if (!isLinking(deps.store)) {
          return res.status(503).json({ error: 'Manage needs migration 0014 (the entity tables) in Supabase.' });
        }
        res.json(await fn(req));
      } catch (err) {
        if (err instanceof ManageError) return res.status(err.status).json({ error: err.message, conflict: err.conflict });
        if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    };
  const store = deps.store;

  // Owner-only canonical archive (spec Phase 1). Members get 403.
  const ownerOnly = (_req: any, res: Response, next: () => void) =>
    currentMember()?.role === 'owner' ? next() : res.status(403).json({ error: 'Only the owner can do this.' });
  router.get(
    '/manage/canonical/editions',
    ownerOnly as any,
    manage(async (req) => {
      const status = ['all', 'confirmed', 'draft'].includes(req.query.status) ? (req.query.status as EditionStatusFilter) : 'all';
      const editions = await store.listEditions(1000);
      return { editions: listCanonicalEditions(editions, { query: typeof req.query.query === 'string' ? req.query.query : '', status }) };
    }),
  );

  router.get(
    '/entities',
    manage(async () => {
      const [entities, aliases, links] = await Promise.all([store.listEntities(), store.listEntityAliases(), store.listEntityLinks()]);
      return { entities, aliases, links, duplicates: possibleDuplicates(entities).map((g) => g.map((e) => e.id)) };
    }),
  );
  // Data health: venues whose events use more than one city, and look-alikes.
  router.get(
    '/entities/health',
    manage(async () => ({
      venuePlaces: await venuePlaceConflicts(store),
      duplicates: possibleDuplicates(await store.listEntities()).map((g) => g.map((e) => e.id)),
    })),
  );
  router.post('/entities/venues/places', manage(async () => ({ entry: await linkVenuePlaces(store) })));
  router.get('/entities/history', manage(async () => ({ history: await store.listEntityHistory(50) })));
  router.post('/entities/history/:id/undo', manage((req) => undoEntry(store, req.params.id)));
  router.post('/entities', manage((req) => createEntity(store, req.body?.kind, req.body?.name, undefined, req.body?.group)));
  router.patch('/entities/:id', manage(async (req) => ({ entry: await renameEntity(store, req.params.id, req.body?.name) })));
  router.patch('/entities/:id/person', manage(async (req) => ({ entry: await updatePerson(store, req.params.id, req.body ?? {}) })));
  router.patch('/entities/:id/attrs', manage(async (req) => ({ entry: await updateAttrs(store, req.params.id, req.body ?? {}) })));
  router.post('/entities/:id/merge', manage(async (req) => ({ entry: await mergeEntity(store, req.params.id, String(req.body?.into ?? '')) })));
  router.post('/entities/:id/aliases', manage(async (req) => ({ entry: await addAlias(store, req.params.id, req.body?.name) })));
  router.post('/entities/:id/aliases/remove', manage(async (req) => ({ entry: await removeAlias(store, req.params.id, req.body?.name) })));
  router.post(
    '/entities/:id/links',
    manage(async (req) => ({ entry: await addLink(store, req.params.id, String(req.body?.to ?? ''), req.body?.role) })),
  );
  router.post(
    '/entities/:id/links/remove',
    manage(async (req) => ({ entry: await removeLink(store, req.params.id, String(req.body?.to ?? ''), req.body?.role) })),
  );

  // Multi-artist collaboration / group project aliases
  router.get('/collaborations', async (_req, res) => {
    try {
      const { listCollaborations } = await import('./collaborations');
      res.json(await listCollaborations(store));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/collaborations', async (req, res) => {
    try {
      const { saveCollaboration } = await import('./collaborations');
      res.json(await saveCollaboration(store, req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/collaborations/:alias', async (req, res) => {
    try {
      const { removeCollaboration } = await import('./collaborations');
      res.json(await removeCollaboration(store, req.params.alias));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
