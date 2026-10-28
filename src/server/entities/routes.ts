import { Router } from 'express';
import { PipelineDeps } from '../lineup/pipeline';
import { isLinking } from './linkingStore';
import { nameIndex } from './link';

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

  return router;
}
