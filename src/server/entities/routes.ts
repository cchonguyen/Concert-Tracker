import { Response, Router } from 'express';
import { InputError, PipelineDeps } from '../lineup/pipeline';
import { defaultFinders, DetailFinder, researchEditionFacts } from '../events/details';
import { isLinking } from './linkingStore';
import { nameIndex, possibleDuplicates } from './link';
import { EntityIntegrityError } from './integrity';
import {
  addArtistAka,
  appearancesFromRefs,
  ArtistChangeInput,
  CANONICAL_EDITION_LIMIT,
  EditionStatusFilter,
  isOwner,
  listCanonicalEditions,
  mergeArtists,
  planArtistChange,
  removeArtistAka,
  renameArtist,
  summarizeEdition,
  saveSeriesLogged,
  undoHistory,
  unifyArtists,
  withAkas,
} from './canonicalManage';
import { CanonicalHistoryCursorError, CanonicalHistoryEntry, CanonicalStoreError, EditionOccurrenceConflictError, isVerifiedStatus } from '../lineup/store/types';
import { currentMember } from '../auth/requestScope';
import { brandsRouter } from '../brands/routes';
import {
  CanonicalInputError,
  EditionNotFoundError,
  confirmCanonicalEdition,
  editEditionFacts,
  mergeCanonicalEditions,
  parseCanonicalInput,
  parseEditionFacts,
} from '../lineup/canonicalIngest';
import { seriesSlugFor } from '../lineup/text';
import type { Edition, SeriesKind, SeriesRecord, SourceType } from '../lineup/types';
import { addEditionAct, writeEdition } from '../canon/editions';
import { lineupProposalPayload, matchEditionName, offersForEditions } from '../canon/nameArtists';
import { normalizeName } from '../lineup/normalizeName';
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

const SERIES_SOURCES = new Set<SourceType>([
  'clashfinder',
  'promoter',
  'wayback',
  'ticketmaster',
  'setlistfm',
  'musicbrainz',
  'discovered',
  'email',
  'user',
]);

function parseSeriesString(v: unknown, field: string, max = 200): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ManageError(`${field} must be text.`, 400);
  const t = v.trim();
  if (t.length > max) throw new ManageError(`${field} is too long.`, 400);
  return t || undefined;
}

function parseSeriesKind(v: unknown): SeriesKind {
  if (v === 'festival' || v === 'tour') return v;
  throw new ManageError('kind must be festival or tour.', 400);
}

function parseSeriesAliases(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ManageError('aliases must be a list of text.', 400);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function parseSeriesSourcePriority(v: unknown): SourceType[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !SERIES_SOURCES.has(x as SourceType))) {
    throw new ManageError('sourcePriority must be a list of valid source types.', 400);
  }
  return [...new Set(v as SourceType[])];
}

// /api/entities: the records behind your events' names (0014).
export function entitiesRouter(deps: PipelineDeps, finders: DetailFinder[] = defaultFinders()): Router {
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
  // Helper to return HTTP 409 with conflict details on edition occurrence collisions.
  function sendOccurrenceConflict(res: Response, err: unknown): boolean {
    if (err instanceof EditionOccurrenceConflictError || (err instanceof Error && err.name === 'EditionOccurrenceConflictError')) {
      const conflictingEdition = (err as EditionOccurrenceConflictError).conflictingEdition;
      res.status(409).json({ error: err.message, ...(conflictingEdition ? { conflictingEdition } : {}) });
      return true;
    }
    return false;
  }

  // Canonical confirm (Phase 2a). Preview by default; { apply: true } writes.
  router.post('/manage/canonical/confirm', ownerOnly as any, async (req, res) => {
    try {
      const input = parseCanonicalInput(req.body);
      res.json(await confirmCanonicalEdition(store, input));
    } catch (err) {
      if (err instanceof CanonicalInputError) return res.status(400).json({ error: err.message });
      if (sendOccurrenceConflict(res, err)) return;
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
      if (sendOccurrenceConflict(res, err)) return;
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Check details for canonical edition facts (draft or stored). Owner only.
  router.post('/manage/canonical/editions/:id/details', ownerOnly as any, async (req, res) => {
    try {
      const edition = await store.getEdition(String(req.params.id));
      if (!edition) return res.status(404).json({ error: 'Edition not found.' });
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : edition.name;
      const startDate = body.startDate !== undefined ? (typeof body.startDate === 'string' && body.startDate.trim() !== '' ? body.startDate.trim() : null) : (edition.startDate ?? null);
      const endDate = body.endDate !== undefined ? (typeof body.endDate === 'string' && body.endDate.trim() !== '' ? body.endDate.trim() : null) : (edition.endDate ?? null);
      const venue = body.venue !== undefined ? (typeof body.venue === 'string' && body.venue.trim() !== '' ? body.venue.trim() : null) : (edition.venue ?? null);
      const city = body.city !== undefined ? (typeof body.city === 'string' && body.city.trim() !== '' ? body.city.trim() : null) : (edition.city ?? null);
      const country = edition.country ?? null;
      const parsedYear = startDate ? Number(startDate.slice(0, 4)) : null;
      const draftYear = parsedYear && Number.isInteger(parsedYear) ? parsedYear : null;
      const year = draftYear ?? edition.year ?? null;
      const useGemini = body.useGemini === true;

      const details = await researchEditionFacts(
        { id: edition.id, name, startDate, endDate, venue, city, country, year },
        finders,
        {
          fetcher: deps.fetcher,
          now: deps.now ? deps.now() : new Date(),
          reader: deps.reader,
          useGemini,
        },
      );
      res.json(details);
    } catch (err) {
      if (err instanceof InputError) return res.status(400).json({ error: err.message });
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Owner verifies a provisional shared edition (slice 12.4). Goes through writeEdition, so undo works.
  // Normalized names of series (name, brand, aliases), venues and organizations: a name remainder equal to one of
  // these blocks a lineup match (docs/edition-lineup-from-name-spec.md, Matching rule 4).
  const NAME_MATCH_EDITION_LIMIT = 5000;
  async function namedPlaceRemainders(s: typeof store): Promise<Set<string>> {
    const out = new Set<string>();
    for (const series of await s.listSeries()) {
      for (const n of [series.name, series.brand, ...(series.aliases ?? [])]) {
        if (n) out.add(normalizeName(n));
      }
    }
    for (const entity of await s.listEntities()) {
      if ((entity.kind === 'venue' || entity.kind === 'series') && !entity.mergedIntoId && entity.nameNormalized) {
        out.add(entity.nameNormalized);
      }
    }
    out.delete('');
    return out;
  }

  // Find gaps (slice 3): every edition whose name starts with a catalog artist who is not on its lineup yet.
  router.get(
    '/manage/canonical/name-matches',
    ownerOnly as any,
    manage(async () => {
      // Headers only (one query), then the lineups of the few editions whose name matched. Loading every
      // edition in full cost a round trip per 100 editions and hit the Worker's subrequest budget.
      const [headers, artists, blocked] = await Promise.all([store.listEditionHeaders({ limit: NAME_MATCH_EDITION_LIMIT }), store.listArtists(), namedPlaceRemainders(store)]);
      const catalog = artists.map((a) => ({ key: a.key, name: a.name }));
      const named = [];
      for (const edition of headers) {
        const match = matchEditionName(edition.name, catalog, blocked);
        if (match) named.push({ edition, match });
      }
      if (!named.length) return { matches: [] };
      const refs = await store.listEditionArtistRefs({ editionIds: named.map((n) => n.edition.id) });
      const onLineup = new Set(refs.map((r) => `${r.editionId}\u0000${r.artistKey}`));
      const matches = [];
      for (const { edition, match } of named) {
        if (onLineup.has(`${edition.id}\u0000${match.artistKey}`)) continue;
        matches.push({ editionId: edition.id, editionName: edition.name, artistKey: match.artistKey, artistName: match.artistName });
      }
      return { matches };
    }),
  );

  // Member proposal (slice 4): a signed-in member proposes a catalog artist named in a shared edition's name. The owner
  // approves or rejects it in the Changes queue. Stored as a review item with no user id and no personal field.
  router.post('/canon/lineup-proposals', (_req: any, res: Response, next: () => void) =>
    currentMember() ? next() : res.status(401).json({ error: 'Sign in to propose an act.' }), async (req, res) => {
    try {
      const edition = await store.getEdition(String(req.body?.editionId ?? ''));
      if (!edition) return res.status(404).json({ error: 'Edition not found.' });
      const artist = await store.getArtist(String(req.body?.artistKey ?? ''));
      if (!artist) return res.status(404).json({ error: 'Artist is not in the catalog.' });
      if (edition.performances.some((p) => p.artistKey === artist.key)) return res.status(409).json({ error: 'Already on the lineup.' });
      const blocked = await namedPlaceRemainders(store);
      if (!matchEditionName(edition.name, [{ key: artist.key, name: artist.name }], blocked)) {
        return res.status(409).json({ error: 'The edition name does not start with this artist.' });
      }
      const open = (await store.listReviewItems({ status: 'open', kind: 'lineup_proposal' })).find(
        (r) => r.editionId === edition.id && (r.payload as { artistKey?: string }).artistKey === artist.key,
      );
      if (open) return res.json({ ok: true, duplicate: true, id: open.id });
      const item = await store.addReviewItem({
        kind: 'lineup_proposal',
        editionId: edition.id,
        payload: lineupProposalPayload(edition.name, { key: artist.key, name: artist.name }) as unknown as Record<string, unknown>,
      });
      res.json({ ok: true, duplicate: false, id: item.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Member lineup offers (slice 5): the catalog acts named in the given linked editions' names that their lineups lack.
  // Returns catalog names and edition ids only, never a personal field. The member tap uses POST /canon/lineup-proposals.
  router.get('/canon/lineup-offers', (_req: any, res: Response, next: () => void) =>
    currentMember() ? next() : res.status(401).json({ error: 'Sign in to see offers.' }), async (req, res) => {
    try {
      const ids = String(req.query?.editionIds ?? '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500);
      const editions = (await Promise.all(ids.map((id) => store.getEdition(id)))).filter((e): e is NonNullable<typeof e> => Boolean(e));
      const [artists, blocked] = await Promise.all([store.listArtists(), namedPlaceRemainders(store)]);
      const catalog = artists.map((a) => ({ key: a.key, name: a.name }));
      res.json({ offers: offersForEditions(editions, catalog, blocked) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Owner approves a member's lineup proposal (slice 4). The match is re-checked, the act goes through addEditionAct.
  router.post('/manage/canonical/proposals/:id/approve', ownerOnly as any, async (req, res) => {
    try {
      const item = (await store.listReviewItems({ kind: 'lineup_proposal' })).find((r) => r.id === String(req.params.id));
      if (!item) return res.status(404).json({ error: 'No such proposal.' });
      if (item.status !== 'open') return res.status(409).json({ error: 'That proposal is already closed.' });
      const edition = item.editionId ? await store.getEdition(item.editionId) : null;
      if (!edition) return res.status(404).json({ error: 'That proposal\'s edition no longer exists.' });
      const p = item.payload as { artistKey?: string; artistName?: string };
      const artist = p.artistKey ? await store.getArtist(p.artistKey) : null;
      if (!artist) return res.status(409).json({ error: 'Artist is no longer in the catalog.' });
      const blocked = await namedPlaceRemainders(store);
      if (!matchEditionName(edition.name, [{ key: artist.key, name: artist.name }], blocked)) {
        return res.status(409).json({ error: 'The edition name no longer matches this artist.' });
      }
      const result = await addEditionAct(store, {
        editionId: edition.id,
        artistKey: artist.key,
        artistName: artist.name,
        actor: 'member proposal',
        reason: 'member proposal',
      });
      if (!result.ok && result.reason === 'already_listed') {
        await store.resolveReviewItem(item.id, 'owner', 'dismissed');
        return res.status(409).json({ error: 'Already on the lineup.' });
      }
      if (!result.ok) return res.status(404).json({ error: 'Edition not found.' });
      await store.resolveReviewItem(item.id, 'owner', 'promoted');
      res.json({ ok: true, changeId: result.changeId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Owner taps an artist named in the edition's name onto its lineup (slice 2). The server re-checks the match.
  router.post('/manage/canonical/editions/:id/lineup', ownerOnly as any, async (req, res) => {
    try {
      const edition = await store.getEdition(String(req.params.id));
      if (!edition) return res.status(404).json({ error: 'Edition not found.' });
      const artist = await store.getArtist(String(req.body?.artistKey ?? ''));
      if (!artist) return res.status(404).json({ error: 'Artist is not in the catalog.' });
      const blocked = await namedPlaceRemainders(store);
      const match = matchEditionName(edition.name, [{ key: artist.key, name: artist.name }], blocked);
      if (!match) return res.status(409).json({ error: 'The edition name does not start with this artist.' });
      const result = await addEditionAct(store, {
        editionId: edition.id,
        artistKey: artist.key,
        artistName: artist.name,
        actor: 'owner',
        reason: 'edition name',
      });
      if (!result.ok) {
        return res.status(result.reason === 'unknown' ? 404 : 409).json({ error: result.reason === 'already_listed' ? 'Already on the lineup.' : 'Edition not found.' });
      }
      res.json({ ok: true, changeId: result.changeId });
    } catch (err) {
      if (sendOccurrenceConflict(res, err)) return;
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/manage/canonical/editions/:id/verify', ownerOnly as any, async (req, res) => {
    try {
      const edition = await store.getEdition(String(req.params.id));
      if (!edition) return res.status(404).json({ error: 'Edition not found.' });
      if (edition.status !== 'provisional') return res.status(409).json({ error: 'Only a provisional edition can be verified here.' });
      const next: Edition = { ...edition, status: 'verified', updatedAt: new Date().toISOString() };
      const written = await writeEdition(store, { edition: next, actor: 'owner', reason: 'verified by owner' });
      res.json({ ok: true, changeId: written.change?.id ?? null, edition: { id: next.id, name: next.name, status: next.status } });
    } catch (err) {
      if (sendOccurrenceConflict(res, err)) return;
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/manage/canonical/editions/:id/merge', ownerOnly as any, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
      if (!body) return res.status(400).json({ error: 'Send a JSON body.' });
      const dropIds = Array.isArray(body.dropIds)
        ? body.dropIds
        : typeof body.dropId === 'string'
          ? [body.dropId]
          : [];
      const result = await mergeCanonicalEditions(store, {
        keepId: String(req.params.id),
        dropIds,
        factChoices: body.factChoices && typeof body.factChoices === 'object' && !Array.isArray(body.factChoices)
          ? (body.factChoices as Record<string, unknown>)
          : undefined,
        combineAsWeekends: body.combineAsWeekends === true,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        actor: 'owner',
      });
      res.json(result);
    } catch (err) {
      if (err instanceof CanonicalInputError) return res.status(400).json({ error: err.message });
      if (err instanceof EditionNotFoundError) return res.status(404).json({ error: err.message });
      if (sendOccurrenceConflict(res, err)) return;
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Canonical series management (owner only).
  router.get('/manage/canonical/series', ownerOnly as any, async (req, res) => {
    try {
      const query = typeof req.query.query === 'string' ? req.query.query : undefined;
      const brand = typeof req.query.brand === 'string' ? req.query.brand : undefined;
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined;
      res.json({ series: await store.listSeries({ query, brand, limit }) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/manage/canonical/series', ownerOnly as any, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
      if (!body) throw new ManageError('Send a JSON body.', 400);
      const name = parseSeriesString(body.name, 'name');
      if (!name) throw new ManageError('Series name is required.', 400);
      const rawSlug = parseSeriesString(body.slug, 'slug', 120);
      const slug = seriesSlugFor(rawSlug ?? name);
      if (!slug) throw new ManageError('Series slug must contain letters or digits.', 400);
      if (await store.getSeries(slug)) throw new ManageError(`Series "${slug}" already exists.`, 409);

      const kind: SeriesKind = 'kind' in body ? parseSeriesKind(body.kind) : 'festival';
      const brand = parseSeriesString(body.brand, 'brand');
      const city = parseSeriesString(body.city, 'city', 200);
      const region = parseSeriesString(body.region, 'region', 100);
      const country = parseSeriesString(body.country, 'country', 100);
      if (kind === 'tour' && (city || region || country)) {
        throw new ManageError('Tour series cannot have a fixed city, region, or country.', 400);
      }
      const aliases = body.aliases !== undefined ? parseSeriesAliases(body.aliases) : undefined;
      const lineupUrl = parseSeriesString(body.lineupUrl, 'lineupUrl', 2000);
      const sourcePriority = body.sourcePriority !== undefined ? parseSeriesSourcePriority(body.sourcePriority) : undefined;

      const record: SeriesRecord = {
        slug,
        name,
        kind,
        ...(brand ? { brand } : {}),
        ...(city ? { city } : {}),
        ...(region ? { region } : {}),
        ...(country ? { country } : {}),
        ...(aliases?.length ? { aliases } : {}),
        ...(lineupUrl ? { lineupUrl } : {}),
        ...(sourcePriority?.length ? { sourcePriority } : {}),
      };
      await store.upsertSeries(record);
      res.status(201).json({ series: (await store.getSeries(slug)) ?? record });
    } catch (err) {
      if (err instanceof ManageError) return res.status(err.status).json({ error: err.message, conflict: err.conflict });
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch('/manage/canonical/series/:slug', ownerOnly as any, async (req, res) => {
    try {
      const slug = String(req.params.slug);
      const existing = await store.getSeries(slug);
      if (!existing) throw new ManageError('No such series.', 404);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
      if (!body) throw new ManageError('Send a JSON body.', 400);

      const next: SeriesRecord = { ...existing };
      if ('name' in body) {
        const name = parseSeriesString(body.name, 'name');
        if (!name) throw new ManageError('Series name cannot be blank.', 400);
        next.name = name;
      }
      if ('kind' in body) {
        next.kind = parseSeriesKind(body.kind);
      }
      const effectiveKind: SeriesKind = next.kind === 'tour' ? 'tour' : 'festival';
      const passedCity = 'city' in body ? parseSeriesString(body.city, 'city', 200) : undefined;
      const passedRegion = 'region' in body ? parseSeriesString(body.region, 'region', 100) : undefined;
      const passedCountry = 'country' in body ? parseSeriesString(body.country, 'country', 100) : undefined;
      if (effectiveKind === 'tour') {
        if (passedCity || passedRegion || passedCountry) {
          throw new ManageError('Tour series cannot have a fixed city, region, or country.', 400);
        }
        delete next.city;
        delete next.region;
        delete next.country;
      } else {
        if ('city' in body) {
          if (passedCity) next.city = passedCity;
          else delete next.city;
        }
        if ('region' in body) {
          if (passedRegion) next.region = passedRegion;
          else delete next.region;
        }
        if ('country' in body) {
          if (passedCountry) next.country = passedCountry;
          else delete next.country;
        }
      }
      if ('brand' in body) {
        const brand = parseSeriesString(body.brand, 'brand');
        if (brand) next.brand = brand;
        else delete next.brand;
      }
      if ('aliases' in body) {
        const aliases = body.aliases === null ? [] : parseSeriesAliases(body.aliases);
        if (aliases.length) next.aliases = aliases;
        else delete next.aliases;
      }
      if ('lineupUrl' in body) {
        const lineupUrl = parseSeriesString(body.lineupUrl, 'lineupUrl', 2000);
        if (lineupUrl) next.lineupUrl = lineupUrl;
        else delete next.lineupUrl;
      }
      if ('sourcePriority' in body) {
        const sourcePriority = body.sourcePriority === null ? [] : parseSeriesSourcePriority(body.sourcePriority);
        if (sourcePriority.length) next.sourcePriority = sourcePriority;
        else delete next.sourcePriority;
      }

      await saveSeriesLogged(store, existing, next);
      res.json({ series: (await store.getSeries(slug)) ?? next });
    } catch (err) {
      if (err instanceof ManageError) return res.status(err.status).json({ error: err.message, conflict: err.conflict });
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/manage/canonical/series/:slug/merge', ownerOnly as any, async (req, res) => {
    try {
      const keepSlug = String(req.params.slug);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
      const dropSlug = body ? parseSeriesString(body.dropSlug, 'dropSlug', 120) : undefined;
      if (!dropSlug) throw new ManageError('dropSlug is required.', 400);
      if (dropSlug === keepSlug) throw new ManageError('Cannot merge a series into itself.', 400);
      if (!(await store.getSeries(keepSlug))) throw new ManageError(`Series "${keepSlug}" not found.`, 404);
      if (!(await store.getSeries(dropSlug))) throw new ManageError(`Series "${dropSlug}" not found.`, 404);
      const merged = await store.mergeSeries(keepSlug, dropSlug);
      res.json({ series: await store.getSeries(keepSlug), merged });
    } catch (err) {
      if (err instanceof ManageError) return res.status(err.status).json({ error: err.message, conflict: err.conflict });
      if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/manage/canonical/series/:slug/editions', ownerOnly as any, async (req, res) => {
    try {
      const slug = String(req.params.slug);
      const series = await store.getSeries(slug);
      if (!series) throw new ManageError('No such series.', 404);
      const headers = await store.listEditionHeaders({ seriesSlug: slug, limit: CANONICAL_EDITION_LIMIT });
      const facts = headers.length ? await store.editionLineupFacts(headers.map((h) => h.id)) : {};
      const editions = headers
        .map((h) => ({ ...summarizeEdition(h), performanceCount: facts[h.id]?.acts ?? 0 }))
        .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
      res.json({ series, editions });
    } catch (err) {
      if (err instanceof ManageError) return res.status(err.status).json({ error: err.message, conflict: err.conflict });
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
      const [canonical, headers, artistRefs, ownerNames, communityCounts, aliases] = await Promise.all([
        store.listArtists(),
        store.listEditionHeaders({ limit: 5000 }),
        store.listEditionArtistRefs(),
        store.listSeenArtistNames(),
        store.communityCounts(),
        store.getAliases(),
      ]);
      const verifiedIds = new Set(headers.filter((h) => isVerifiedStatus(h.status)).map((h) => h.id));
      const verifiedRefs = artistRefs.filter((r) => verifiedIds.has(r.editionId));
      const row = withAkas(unifyArtists({ canonical, ownerNames, artistRefs: verifiedRefs, communityCounts }), aliases).find((a) => a.key === key);
      if (!row) throw new ManageError('No such artist.', 404);
      return { artist: row, appearances: appearancesFromRefs(headers, artistRefs, key) };
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
      const [canonical, artistRefs, ownerNames, communityCounts, aliases] = await Promise.all([
        store.listArtists(),
        store.listEditionArtistRefs({ verifiedOnly: true }),
        store.listSeenArtistNames(),
        store.communityCounts(),
        store.getAliases(),
      ]);
      return { artists: withAkas(unifyArtists({ canonical, ownerNames, artistRefs, communityCounts }), aliases) };
    }),
  );
  router.get(
    '/manage/canonical/editions',
    ownerOnly as any,
    manage(async (req) => {
      const status = ['all', 'verified', 'confirmed', 'provisional', 'draft'].includes(req.query.status) ? (req.query.status as EditionStatusFilter) : 'all';
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

  router.post('/collaborations', ownerOnly as any, async (req, res) => {
    try {
      const { saveCollaboration } = await import('./collaborations');
      res.json(await saveCollaboration(store, req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/collaborations/:alias', ownerOnly as any, async (req, res) => {
    try {
      const { removeCollaboration } = await import('./collaborations');
      res.json(await removeCollaboration(store, req.params.alias));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Brands under organizations (Global Editions slice 2.8). Owner only.
  router.use(brandsRouter({ isOwner: () => isOwner(currentMember()) }));
  return router;
}
