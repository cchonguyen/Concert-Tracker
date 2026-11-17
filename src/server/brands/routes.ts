// Owner-only brand routes (Global Editions slice 2.8). The actions are plain functions over a
// BrandStore so tests can call them directly; the router only maps them to HTTP.
import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../supabase';
import { BrandError, type BrandRow } from './plan';
import {
  BrandStore,
  createSupabaseBrandStore,
  mergeBrands,
  renameBrand,
  setBrandOrganization,
  undoBrandChange,
  type BrandHistoryRow,
  type ApplyDeps,
} from './store';

export interface BrandActions {
  list(): Promise<BrandRow[]>;
  rename(id: string, name: unknown): Promise<BrandHistoryRow>;
  setOrganization(id: string, organizationId: unknown): Promise<BrandHistoryRow>;
  merge(sourceId: unknown, targetId: unknown): Promise<BrandHistoryRow>;
  undo(historyId: string): Promise<BrandHistoryRow>;
}

const idOf = (raw: unknown, what: string): string => {
  if (typeof raw !== 'string' || !raw.trim()) throw new BrandError(`Pick the ${what} first.`);
  return raw.trim();
};

// Organization ids are entity ids (uuid strings). null detaches.
const organizationOf = (raw: unknown): string | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw)) throw new BrandError('Pick a valid organization or none.');
  return raw;
};

export function brandActions(store: BrandStore, newId: () => string = () => crypto.randomUUID()): BrandActions {
  const deps: ApplyDeps = { store, newId };
  return {
    list: () => store.listBrands(),
    // Async so that input errors arrive as rejections, the same as store errors.
    rename: async (id, name) => renameBrand(deps, idOf(id, 'brand'), name),
    setOrganization: async (id, organizationId) =>
      setBrandOrganization(deps, idOf(id, 'brand'), organizationOf(organizationId)),
    merge: async (sourceId, targetId) =>
      mergeBrands(deps, idOf(sourceId, 'brand to merge'), idOf(targetId, 'brand to keep')),
    undo: async (historyId) => undoBrandChange(deps, idOf(historyId, 'change')),
  };
}

// Maps a thrown error to an HTTP status and message. Unknown errors are server errors.
export function brandErrorStatus(err: unknown): { status: number; error: string } {
  if (err instanceof BrandError) return { status: err.status, error: err.message };
  return { status: 500, error: err instanceof Error ? err.message : String(err) };
}

// Mounted from entitiesRouter. Without a Supabase client (local file mode) the routes answer 503.
export function brandsRouter(opts: { store?: BrandStore; isOwner: (req: Request) => boolean }): Router {
  const router = Router();
  const actions = (): BrandActions | null => {
    const store = opts.store ?? (getSupabaseClient() ? createSupabaseBrandStore(getSupabaseClient()!) : null);
    return store ? brandActions(store) : null;
  };
  const guard = (req: Request, res: Response, run: (a: BrandActions) => Promise<unknown>) => {
    if (!opts.isOwner(req)) return res.status(403).json({ error: 'Only the owner can do this.' });
    const a = actions();
    if (!a) return res.status(503).json({ error: 'Brands need the database to be configured.' });
    run(a)
      .then((body) => res.json(body))
      .catch((err) => {
        const { status, error } = brandErrorStatus(err);
        res.status(status).json({ error });
      });
    return undefined;
  };

  router.get('/manage/brands', (req, res) => guard(req, res, async (a) => ({ brands: await a.list() })));
  router.patch('/manage/brands/:id', (req, res) =>
    guard(req, res, (a) => a.rename(req.params.id, req.body?.name)),
  );
  router.patch('/manage/brands/:id/organization', (req, res) =>
    guard(req, res, (a) => a.setOrganization(req.params.id, req.body?.organizationId)),
  );
  router.post('/manage/brands/merge', (req, res) =>
    guard(req, res, (a) => a.merge(req.body?.sourceId, req.body?.targetId)),
  );
  router.post('/manage/brands/history/:id/undo', (req, res) => guard(req, res, (a) => a.undo(req.params.id)));
  return router;
}
