import { Response, Router } from 'express';
import { PipelineDeps } from '../lineup/pipeline';
import { isLinking } from './linkingStore';
import { nameIndex, possibleDuplicates } from './link';
import { EntityIntegrityError } from './integrity';
import {
  addArtistAka,
  appearancesOf,
  ArtistChangeInput,
  CANONICAL_EDITION_LIMIT,
  EditionStatusFilter,
  isOwner,
  listCanonicalEditions,
  mergeArtists,
  planArtistChange,
  removeArtistAka,
  renameArtist,
  undoHistory,
  unifyArtists,
  withAkas,
} from './canonicalManage';
import { CanonicalHistoryCursorError, CanonicalHistoryEntry, CanonicalStoreError } from '../lineup/store/types';
import { currentMember } from '../auth/requestScope';
import {
  CanonicalInputError,
  EditionNotFoundError,
  confirmCanonicalEdition,
  editEditionFacts,
  parseCanonicalInput,
  parseEditionFacts,
} from '../lineup/canonicalIngest';
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
  venuePlaceConflicts,
} from './manage';

// Canonical artist preview and apply (slice 8.7). The body is one operation. Unknown ops, missing
// name/into and extra fields are refused with 400. The apply body also takes previewFingerprint.
const ARTIST_OPS = ['rename', 'alias-add', 'alias-remove', 'merge'] as const;
const PREVIEW_STALE = 'Preview is out of date; review it again';

// Owner's Changes list (slice UX3): canonical operations only, newest first, 50 per page. The manifest and
// member details stay on the server; a row carries only what the list shows.
const CHANGES_PAGE = 50;

type ChangeManifest = { summary?: unknown; canonical?: { artists?: Record<string, unknown>; aliases?: Record<string, unknown> } };

const namesIn = (list: unknown): string[] =>
  Array.isArray(list) ? list.flatMap((x) => (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? [(x as { name: string }).name] : [])) : [];
const akasIn = (list: unknown): string[] =>
  Array.isArray(list) ? list.flatMap((x) => (x && typeof x === 'object' && typeof (x as { alias?: unknown }).alias === 'string' ? [(x as { alias: string }).alias] : [])) : [];

// One side of a change as text: the artist names, then the AKAs ("Old Artist · AKA Old AKA"). "none" when empty.
function changeSide(canonical: ChangeManifest['canonical'], side: 'before' | 'after'): string {
  const names = namesIn(canonical?.artists?.[side]);
  const akas = akasIn(canonical?.aliases?.[side]);
  return [names.join(', '), akas.length ? `AKA ${akas.join(', ')}` : ''].filter(Boolean).join(' · ') || 'none';
}

function changeRow(entry: CanonicalHistoryEntry) {
  const m = (entry.manifest && typeof entry.manifest === 'object' ? entry.manifest : {}) as ChangeManifest;
  return {
    id: entry.id,
    operation: entry.operation,
    summary: typeof m.summary === 'string' ? m.summary : '',
    time: entry.createdAt,
    before: changeSide(m.canonical, 'before'),
    after: changeSide(m.canonical, 'after'),
    undoneAt: entry.undoneAt ?? null,
  };
}

function artistChangeBody(body: unknown, withFingerprint: boolean): { input: ArtistChangeInput; previewFingerprint?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ManageError('Send one operation: rename, alias-add, alias-remove or merge.', 400);
  const fields = body as Record<string, unknown>;
  const op = fields.op;
  if (typeof op !== 'string' || !(ARTIST_OPS as readonly string[]).includes(op)) throw new ManageError('Unknown operation.', 400);
  const field = op === 'merge' ? 'into' : 'name';
  const allowed = ['op', field, ...(withFingerprint ? ['previewFingerprint'] : [])];
  const extra = Object.keys(fields).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new ManageError(`Unexpected field: ${extra}.`, 400);
  const value = fields[field];
  if (typeof value !== 'string' || value.trim() === '') throw new ManageError(`Missing ${field}.`, 400);
  const previewFingerprint = fields.previewFingerprint;
  if (withFingerprint && (typeof previewFingerprint !== 'string' || previewFingerprint === '')) {
    throw new ManageError('Missing previewFingerprint.', 400);
  }
  const input: ArtistChangeInput = op === 'merge' ? { op, into: value } : { op: op as 'rename' | 'alias-add' | 'alias-remove', name: value };
  return withFingerprint ? { input, previewFingerprint: previewFingerprint as string } : { input };
}

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
    isOwner(currentMember()) ? next() : res.status(403).json({ error: 'Only the owner can do this.' });
  // Canonical confirm (Phase 2a). Preview by default; { apply: true } writes.
  router.post('/manage/canonical/confirm', ownerOnly as any, async (req, res) => {
    try {
      const input = parseCanonicalInput(req.body);
      res.json(await confirmCanonicalEdition(store, input));
    } catch (err) {
      if (err instanceof CanonicalInputError) return res.status(400).json({ error: err.message });
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Edition facts (GA4): name, dates, venue, city with a required source note. Owner only; catalog only.
  router.patch('/manage/canonical/editions/:id/facts', ownerOnly as any, async (req, res) => {
    try {
      const input = parseEditionFacts(req.body);
      res.json({ edition: await editEditionFacts(store, String(req.params.id), input) });
    } catch (err) {
      if (err instanceof CanonicalInputError) return res.status(400).json({ error: err.message });
      if (err instanceof EditionNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Detail views (owner only): one edition with its acts, one artist with the editions they appear in.
  router.get(
    '/manage/canonical/editions/:id',
    ownerOnly as any,
    manage(async (req) => {
      const edition = await store.getEdition(req.params.id);
      if (!edition) throw new ManageError('No such edition.', 404);
      return { edition };
    }),
  );
  router.get(
    '/manage/canonical/artists/:key',
    ownerOnly as any,
    manage(async (req) => {
      const key = String(req.params.key);
      const [canonical, editions, ownerNames, communityCounts, aliases] = await Promise.all([
        store.listArtists(),
        store.listEditions(CANONICAL_EDITION_LIMIT),
        store.listSeenArtistNames(),
        store.communityCounts(),
        store.getAliases(),
      ]);
      const row = withAkas(unifyArtists({ canonical, ownerNames, editions, communityCounts }), aliases).find((a) => a.key === key);
      if (!row) throw new ManageError('No such artist.', 404);
      return { artist: row, appearances: appearancesOf(editions, key) };
    }),
  );
  // Catalog artists as records (GA3): rename, merge, AKAs. Each one writes a history entry, so Undo works.
  router.patch(
    '/manage/canonical/artists/:key',
    ownerOnly as any,
    manage(async (req) => ({ entry: await renameArtist(store, String(req.params.key), req.body?.name) })),
  );
  router.post(
    '/manage/canonical/artists/:key/merge',
    ownerOnly as any,
    manage(async (req) => ({ entry: await mergeArtists(store, String(req.params.key), String(req.body?.into ?? '')) })),
  );
  router.post(
    '/manage/canonical/artists/:key/aliases',
    ownerOnly as any,
    manage(async (req) => ({ entry: await addArtistAka(store, String(req.params.key), req.body?.name) })),
  );
  // The AKA in the body, or in ?name= for clients that cannot send a body with DELETE.
  router.delete(
    '/manage/canonical/artists/:key/aliases',
    ownerOnly as any,
    manage(async (req) => ({ entry: await removeArtistAka(store, String(req.params.key), req.body?.name ?? req.query.name) })),
  );
  // Preview (writes nothing): the plan's operation, impact counts and an opaque fingerprint of the rows it relies on.
  router.post(
    '/manage/canonical/artists/:key/preview',
    ownerOnly as any,
    manage(async (req) => {
      const { input } = artistChangeBody(req.body, false);
      const plan = await planArtistChange(store, String(req.params.key), input);
      const previewFingerprint = await store.canonicalArtistFingerprint(plan.entry);
      return { operation: plan.operation, impact: plan.impact, previewFingerprint };
    }),
  );
  // Apply: the plan is recomputed here from the body (never taken from the client). The store checks the
  // fingerprint in the same transaction as the write; a mismatch is a 409 and writes nothing.
  router.post(
    '/manage/canonical/artists/:key/apply',
    ownerOnly as any,
    manage(async (req) => {
      const { input, previewFingerprint } = artistChangeBody(req.body, true);
      const plan = await planArtistChange(store, String(req.params.key), input);
      try {
        const applied = await store.applyCanonicalArtistChange(plan.entry, previewFingerprint as string);
        return {
          entry: { id: applied.id, operation: applied.operation, summary: plan.summary, at: plan.at },
          communityNameKeysAffected: plan.impact.communityNameKeysAffected,
        };
      } catch (err) {
        if (err instanceof CanonicalStoreError && err.code === 'stale') throw new ManageError(PREVIEW_STALE, 409);
        if (err instanceof CanonicalStoreError && err.code === 'forbidden') throw new ManageError('Only the owner can do this.', 403);
        throw err;
      }
    }),
  );
  router.get(
    '/manage/canonical/artists',
    ownerOnly as any,
    manage(async () => {
      const [canonical, editions, ownerNames, communityCounts, aliases] = await Promise.all([
        store.listArtists(),
        store.listEditions(CANONICAL_EDITION_LIMIT),
        store.listSeenArtistNames(),
        store.communityCounts(),
        store.getAliases(),
      ]);
      return { artists: withAkas(unifyArtists({ canonical, ownerNames, editions, communityCounts }), aliases) };
    }),
  );
  router.get(
    '/manage/canonical/editions',
    ownerOnly as any,
    manage(async (req) => {
      const status = ['all', 'confirmed', 'draft'].includes(req.query.status) ? (req.query.status as EditionStatusFilter) : 'all';
      const page = await store.listCanonicalEditionsPage({
        query: typeof req.query.query === 'string' ? req.query.query : '',
        status,
        limit: CANONICAL_EDITION_LIMIT,
      });
      return { editions: listCanonicalEditions(page.editions), total: page.total, hasMore: page.hasMore };
    }),
  );

  // Owner only. Keyset paging on (createdAt, id) descending; nextCursor is null on the last page.
  router.get(
    '/manage/canonical/changes',
    ownerOnly as any,
    manage(async (req) => {
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor !== '' ? req.query.cursor : null;
      try {
        const page = await store.listCanonicalHistoryPage({ limit: CHANGES_PAGE, cursor });
        return { changes: page.entries.map(changeRow), nextCursor: page.nextCursor, hasMore: page.nextCursor !== null };
      } catch (err) {
        if (err instanceof CanonicalHistoryCursorError) throw new ManageError('That page of changes is out of date. Reload the list.', 400);
        throw err;
      }
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
  // Undoes a Manage change or a catalog artist change (canonicalManage.ts).
  router.post('/entities/history/:id/undo', manage((req) => undoHistory(store, req.params.id)));
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
