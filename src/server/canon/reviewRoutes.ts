// Owner routes for the review queue (slice 11.21). Owner only. Every edition write goes through writeEdition.
// Responses carry ids, field names and public edition facts only; never a personal field. No model calls.
import { Router } from 'express';
import { currentMember } from '../auth/requestScope';
import { isOwner } from '../entities/canonicalManage';
import { isVerifiedStatus, LineupStore } from '../lineup/store/types';
import type { Edition, ReviewQueueItem, ReviewQueueKind } from '../lineup/types';
import { undoEditionChange, writeEdition } from './editions';

const KINDS: ReviewQueueKind[] = ['override', 'merge_suggestion', 'provisional', 'formatting', 'failed_lookup'];
const STATUSES = ['open', 'resolved', 'dismissed', 'promoted', 'verified', 'merged'];
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const OVERRIDE_FIELDS = ['name', 'startDate', 'endDate', 'venue', 'city', 'country'] as const;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const publicEdition = (e: Edition) => ({
  id: e.id,
  name: e.name,
  startDate: e.startDate ?? null,
  endDate: e.endDate ?? null,
  venue: e.venue ?? null,
  city: e.city ?? null,
  country: e.country ?? null,
  status: e.status,
});

const view = (r: ReviewQueueItem, edition: Edition | null) => ({ ...r, edition: edition ? publicEdition(edition) : null });

export function canonReviewRouter(store: LineupStore): Router {
  const router = Router();
  const guard = (fn: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => {
    if (!isOwner(currentMember())) return res.status(403).json({ error: 'Only the owner can do this.' });
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Loads an open item of the wanted kind, or throws a clear 4xx.
  async function openItem(id: string, kind: ReviewQueueKind): Promise<ReviewQueueItem> {
    if (!ID.test(id)) throw new HttpError(400, 'That is not a valid item id.');
    const item = (await store.listReviewItems()).find((r) => r.id === id);
    if (!item) throw new HttpError(404, 'No such review item.');
    if (item.kind !== kind) throw new HttpError(400, `That item is a ${item.kind} item, not ${kind}.`);
    if (item.status !== 'open') throw new HttpError(409, 'That item is already closed.');
    return item;
  }
  async function editionOf(item: ReviewQueueItem): Promise<Edition> {
    const ed = item.editionId ? await store.getEdition(item.editionId) : null;
    if (!ed) throw new HttpError(404, 'That item\'s edition no longer exists.');
    return ed;
  }
  const close = async (id: string, status: string) => {
    if (!(await store.resolveReviewItem(id, 'owner', status))) throw new HttpError(409, 'That item is already closed.');
  };

  router.get('/canon/review', guard(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (status !== undefined && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
    if (kind !== undefined && !KINDS.includes(kind as ReviewQueueKind)) throw new HttpError(400, 'Unknown kind.');
    const items = (await store.listReviewItems({ ...(status ? { status } : {}), ...(kind ? { kind: kind as ReviewQueueKind } : {}) })).sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
    );
    const cache = new Map<string, Edition | null>();
    const out = [];
    for (const r of items) {
      if (r.editionId && !cache.has(r.editionId)) cache.set(r.editionId, await store.getEdition(r.editionId));
      out.push(view(r, r.editionId ? cache.get(r.editionId) ?? null : null));
    }
    res.json({ items: out });
  }));

  // Recent ingest traces, newest first. Steps and counts only; a missing table (migration 0043) is reported, not thrown.
  router.get('/canon/traces', guard(async (req, res) => {
    const n = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 20;
    try {
      res.json({ traces: await store.listIngestTraces(limit), tableMissing: false });
    } catch (err) {
      if (/0043|ingest_traces/.test(err instanceof Error ? err.message : String(err))) return res.json({ traces: [], tableMissing: true });
      throw err;
    }
  }));

  router.post('/canon/review/:id/promote', guard(async (req, res) => {
    const item = await openItem(req.params.id, 'override');
    const p = item.payload as { field?: string; old?: string | null; new?: string | null };
    const field = p.field as (typeof OVERRIDE_FIELDS)[number];
    if (!OVERRIDE_FIELDS.includes(field)) throw new HttpError(400, 'That override is not for a shared field.');
    const edition = await editionOf(item);
    const current = (edition as any)[field] ?? null;
    if (current !== (p.old ?? null) && req.body?.force !== true) {
      throw new HttpError(409, 'The edition changed since this override. Send force to apply it anyway.');
    }
    if (field === 'name' && !p.new) throw new HttpError(400, 'An edition name cannot be empty.');
    const next: Edition = { ...edition, [field]: p.new ?? undefined, updatedAt: new Date().toISOString() };
    const written = await writeEdition(store, { edition: next, actor: 'owner', reason: 'promoted from override' });
    await close(item.id, 'promoted');
    res.json({ ok: true, changeId: written.change?.id ?? null, edition: publicEdition(next) });
  }));

  router.post('/canon/review/:id/verify', guard(async (req, res) => {
    const item = await openItem(req.params.id, 'provisional');
    const edition = await editionOf(item);
    const next: Edition = { ...edition, status: 'verified', updatedAt: new Date().toISOString() };
    const written = isVerifiedStatus(edition.status)
      ? { change: undefined }
      : await writeEdition(store, { edition: next, actor: 'owner', reason: 'verified by owner' });
    await close(item.id, 'verified');
    res.json({ ok: true, changeId: written.change?.id ?? null, edition: publicEdition(next) });
  }));

  router.post('/canon/review/:id/merge', guard(async (req, res) => {
    const item = await openItem(req.params.id, 'merge_suggestion');
    const ids = [...new Set([...(((item.payload as any)?.editionIds as unknown[]) ?? []), item.editionId].filter((x): x is string => typeof x === 'string'))];
    if (ids.length < 2) throw new HttpError(400, 'That suggestion does not name two editions.');
    const body = req.body ?? {};
    for (const k of ['keep', 'drop']) if (body[k] !== undefined && (typeof body[k] !== 'string' || !ids.includes(body[k]))) throw new HttpError(400, `${k} must be one of the suggested editions.`);
    const editions = (await Promise.all(ids.map((id) => store.getEdition(id)))).filter((e): e is Edition => Boolean(e));
    if (editions.length < 2) throw new HttpError(404, 'One of those editions no longer exists.');
    const keep: string = body.keep ?? editions.find((e) => isVerifiedStatus(e.status))?.id ?? editions[0].id;
    const others = editions.filter((e) => e.id !== keep);
    const drop: string | undefined = body.drop ?? (others.length === 1 ? others[0].id : undefined);
    if (!drop) throw new HttpError(400, 'Name which edition to drop.');
    if (drop === keep) throw new HttpError(400, 'Keep and drop must differ.');
    const summary = await store.mergeEditions(keep, drop, 'owner', typeof body.reason === 'string' && body.reason ? body.reason : 'merged by owner');
    await close(item.id, 'merged');
    res.json({ ok: true, keep, drop, summary });
  }));

  router.post('/canon/review/:id/dismiss', guard(async (req, res) => {
    if (!ID.test(req.params.id)) throw new HttpError(400, 'That is not a valid item id.');
    const item = (await store.listReviewItems()).find((r) => r.id === req.params.id);
    if (!item) throw new HttpError(404, 'No such review item.');
    if (item.status !== 'open') throw new HttpError(409, 'That item is already closed.');
    await close(item.id, 'dismissed');
    res.json({ ok: true });
  }));

  // The edition is named in the body because changes are listed per edition.
  router.post('/canon/changes/:id/undo', guard(async (req, res) => {
    const editionId = req.body?.editionId;
    if (!ID.test(req.params.id)) throw new HttpError(400, 'That is not a valid change id.');
    if (typeof editionId !== 'string' || !ID.test(editionId)) throw new HttpError(400, 'editionId is required.');
    const result = await undoEditionChange(store, editionId, req.params.id, 'owner');
    if (result.ok) return res.json({ ok: true, change: result.change });
    const map = { unknown: [404, 'No such change.'], already_undone: [409, 'That change was already undone.'], stale: [409, 'The edition changed after this. Undo the later change first.'], not_undoable: [409, 'That change cannot be undone.'] } as const;
    const [status, error] = map[result.reason];
    res.status(status).json({ error });
  }));

  return router;
}
