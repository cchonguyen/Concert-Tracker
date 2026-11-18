import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  canonicalApi,
  CanonicalChangeRow,
  entitiesApi,
  FIELD_SOURCE_LABELS,
  inboxApi,
  lineupApi,
  type LineupStatus,
  LookupJob,
  SOURCE_LABELS,
  UndoConflictError,
} from '../services/lineupApi';
import { reviewSubjectFromEdition } from '../services/reviewRows';
import { brandsApi, type BrandRecord } from '../services/brandsApi';
import type { Edition, EditionPerformance, EditionWeekend, SeriesKind, SeriesRecord, SeriesSummary, SourceType } from '../server/lineup/types';
import type { DetailCandidate, EventDetails } from '../server/events/types';
import type { ArtistAppearance, CanonicalArtistRecord, CanonicalEditionSummary } from '../server/entities/canonicalManage';
import { sameCountry } from '../server/events/regions';
import { CanonicalArtistEntry, ORIGIN_LABEL, type SavedChange } from './CanonicalArtistEntry';
import { CheckDetails, type Suggestion } from './CheckDetails';
import { LineupReview } from './LineupReview';
import { MergeEditionModal } from './MergeEditionModal';
import { usePlaceAutofill } from './PlaceFields';
import { SuggestInput } from './SuggestInput';
import { shortDateRange, weekendLabel } from '../services/format';
import { buildPastPlaces, cityPickPatch, formatPlaceLabel, unanimousPlace } from '../services/placeAutofill';
import { seedMultiWeekends } from '../services/weekends';
import { Button } from './ui/Button';
import { Callout } from './ui/Callout';
import { Notice } from './ui/Notice';
import { Pill } from './ui/Pill';
import { Segmented } from './ui/Segmented';
import { VersionPicker } from './ui/VersionPicker';
import {
  buildManageUrl,
  canonicalArtistUrl,
  editionUrl,
  isModifiedClick,
  parseManageParams,
  rememberManageSearch,
  seriesUrl,
} from '../services/manageNav';

// Global Archive (owner only, spec Phase 4). Each section is one body rendered by ManageView:
// Artists, Series, Editions & Lineups, Lookups, Changes. Counts only; no member names. Never writes a personal log.
// The search box and the edition status filter live in ManageView and arrive as props.

export type ArchiveSection = 'artists' | 'series' | 'brands' | 'editions' | 'lookups' | 'changes';
export type EditionStatus = 'all' | 'verified' | 'provisional' | 'draft';

// An edition's status in words. 'confirmed' is the legacy name for verified.
export function editionStatusWords(status: string): string {
  if (status === 'verified' || status === 'confirmed') return 'Verified';
  if (status === 'provisional') return 'Provisional (not yet checked)';
  return 'Draft (owner only)';
}

// The ingest queue's status, in words (the Pill tone adds color; the words carry the meaning).
const STATUS_WORDS: Record<LookupJob['status'], string> = {
  queued: 'Queued',
  running: 'Fetching',
  waiting_quota: 'Waiting for quota',
  needs_review: 'Ready to review',
  no_data: 'No lineup found',
  confirmed: 'Saved to the archive',
  failed: 'Failed',
};
const STATUS_TONE: Record<LookupJob['status'], 'neutral' | 'accent' | 'warn' | 'good'> = {
  queued: 'neutral',
  running: 'neutral',
  waiting_quota: 'warn',
  needs_review: 'accent',
  no_data: 'warn',
  confirmed: 'good',
  failed: 'warn',
};
const isActive = (j: LookupJob) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting_quota';
// Retry runs the job again now (POST /api/lookups/:id/run).
const canRetry = (j: LookupJob) => j.status === 'waiting_quota' || j.status === 'no_data' || j.status === 'failed';
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const field = 'rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none';

export const CanonicalArchive: React.FC<{ section: ArchiveSection; query: string; status: EditionStatus }> = ({ section, query, status }) => {
  if (section === 'lookups') return <ArchiveLookups />;
  if (section === 'changes') return <ArchiveChanges />;
  if (section === 'series') return <ArchiveSeries query={query} />;
  if (section === 'brands') return <ArchiveBrands query={query} />;
  if (section === 'editions') return <ArchiveEditions query={query} status={status} />;
  return <ArchiveArtists query={query} />;
};

const ArchiveArtists: React.FC<{ query: string }> = ({ query }) => {
  const [artists, setArtists] = useState<CanonicalArtistRecord[] | null>(null);
  const [detail, setDetail] = useState<{ artist: CanonicalArtistRecord; appearances: ArtistAppearance[] } | null>(null);
  const detailRef = useRef<{ artist: CanonicalArtistRecord; appearances: ArtistAppearance[] } | null>(null);
  detailRef.current = detail;
  // The last saved change, with its Undo (the history entry's id).
  const [notice, setNotice] = useState<{ text: string; undo?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(
    () =>
      canonicalApi
        .artists()
        .then((r) => setArtists(r.artists))
        .catch((err) => setError(messageOf(err))),
    [],
  );
  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openArtist = useCallback(async (key: string) => {
    setError(null);
    try {
      const r = await canonicalApi.artist(key);
      setDetail({ artist: r.artist, appearances: r.appearances });
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const handleBackToArtists = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.state?.fromManageList) {
      window.history.back();
    } else {
      const url = buildManageUrl(
        { scope: 'archive', section: 'artists', q: query || undefined },
        typeof window !== 'undefined' ? window.location.pathname : '/app',
      );
      window.history.replaceState(null, '', url);
      rememberManageSearch(new URL(url, window.location.origin).search);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [query]);

  useEffect(() => {
    const syncFromUrl = () => {
      const params = parseManageParams(window.location.search);
      if (params.artist) {
        if (detailRef.current?.artist.key !== params.artist) {
          void openArtist(params.artist);
        }
      } else if (detailRef.current) {
        setDetail(null);
      }
    };
    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, [openArtist]);

  // A saved change: show it with Undo, then the artist where it now is (the list after a merge).
  const changed = async (entry: SavedChange, key: string | null) => {
    setNotice({ text: `${entry.summary}.`, undo: entry.id });
    await loadList();
    if (key === null) {
      handleBackToArtists();
    } else {
      const url = canonicalArtistUrl(key, { q: query || undefined });
      window.history.replaceState({ fromManageList: window.history.state?.fromManageList }, '', url);
      rememberManageSearch(new URL(url, window.location.origin).search);
      await openArtist(key);
    }
  };

  const undo = async (id: string) => {
    setBusy(true);
    try {
      const r = await entitiesApi.undo(id);
      setNotice({ text: `Undid: ${r.entry.summary}.` });
      handleBackToArtists();
      await loadList();
    } catch (err) {
      setNotice({ text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const noticeLine = notice && (
    <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
      {notice.text}
      {notice.undo && (
        <button onClick={() => void undo(notice.undo!)} disabled={busy} className="text-violet-300 hover:text-violet-200 disabled:opacity-40">
          Undo
        </button>
      )}
    </p>
  );

  if (detail) {
    return (
      <div className="space-y-4">
        {noticeLine}
        <CanonicalArtistEntry
          artist={detail.artist}
          appearances={detail.appearances}
          artists={artists ?? []}
          onBack={handleBackToArtists}
          onChanged={(entry, key) => void changed(entry, key)}
        />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = (artists ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.key.includes(q) || a.akas.some((k) => k.includes(q)));

  return (
    <section className="space-y-2">
      {noticeLine}
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {artists === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      ) : artists.length === 0 ? (
        <p className="text-sm text-zinc-400">No artists yet.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-zinc-400">No artist matches "{query}".</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {shown.map((a) => {
            const url = canonicalArtistUrl(a.key, { q: query || undefined });
            return (
              <li key={a.key}>
                <a
                  href={url}
                  onClick={(e) => {
                    if (isModifiedClick(e)) return;
                    e.preventDefault();
                    window.history.pushState({ fromManageList: true }, '', url);
                    rememberManageSearch(new URL(url, window.location.origin).search);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }}
                  className="flex w-full flex-wrap items-center gap-2 p-2.5 text-left text-sm hover:bg-zinc-900/60"
                >
                  <span className="text-zinc-100">{a.name}</span>
                  {a.origins.map((o) => (
                    <Pill key={o} tone="neutral">{ORIGIN_LABEL[o]}</Pill>
                  ))}
                  <span className="text-[11px] text-zinc-500">{a.mbid ? 'MusicBrainz' : 'No MusicBrainz id'}</span>
                  {a.akas.length > 0 && <span className="basis-full text-xs text-zinc-500">Also known as {a.akas.join(', ')}</span>}
                  <span className="ml-auto text-xs text-zinc-400">
                    {a.editionsCount} billed {a.editionsCount === 1 ? 'edition' : 'editions'}
                    {a.communityCount === null ? '' : ` · ${a.communityCount} community`}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

const SOURCE_PRIORITY_OPTIONS: SourceType[] = [
  'promoter',
  'clashfinder',
  'wayback',
  'ticketmaster',
  'setlistfm',
  'musicbrainz',
  'discovered',
  'email',
  'user',
];

const parseAliasText = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Brands (Global Editions slice 2.9): one table of brands with rename, merge into another brand,
// organization, and undo of the last change. Owner only; shared data, so no personal fields.
const ArchiveBrands: React.FC<{ query: string }> = ({ query }) => {
  const [brands, setBrands] = useState<BrandRecord[] | null>(null);
  const [organizations, setOrganizations] = useState<Array<{ id: string; name: string }>>([]);
  const [editing, setEditing] = useState<{ id: string; mode: 'rename' | 'merge' } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last change and the history entry that undoes it.
  const [notice, setNotice] = useState<{ text: string; undoId: string } | null>(null);

  const load = useCallback(
    () =>
      brandsApi
        .list()
        .then((rows) => {
          setBrands(rows);
          setError(null);
        })
        .catch((err) => setError(messageOf(err))),
    [],
  );
  useEffect(() => {
    void load();
    entitiesApi
      .list()
      .then((r) => setOrganizations(r.entities.filter((e) => e.kind === 'organization').map((e) => ({ id: e.id, name: e.name }))))
      .catch(() => setOrganizations([]));
  }, [load]);

  const orgName = useMemo(() => new Map(organizations.map((o) => [o.id, o.name])), [organizations]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = brands ?? [];
    if (!q) return rows;
    return rows.filter((b) => [b.name, ...b.aliases].some((n) => n.toLowerCase().includes(q)));
  }, [brands, query]);

  const run = async (text: string, action: () => Promise<{ id: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const entry = await action();
      setEditing(null);
      setNotice({ text, undoId: entry.id });
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!notice) return;
    await run('Undone.', () => brandsApi.undo(notice.undoId));
    setNotice(null);
  };

  return (
    <section className="space-y-3">
      {error && <Notice tone="warning">{error}</Notice>}
      {notice && (
        <div className="flex flex-wrap items-center gap-2">
          <Notice tone="success">{notice.text}</Notice>
          <Button variant="ghost" onClick={() => void undo()} disabled={busy}>
            Undo
          </Button>
        </div>
      )}
      {brands === null && !error && <p className="text-sm text-zinc-500">Loading brands…</p>}
      {brands && brands.length === 0 && <p className="text-sm text-zinc-500">No brands yet. A brand appears once a series has one.</p>}
      {visible.length > 0 && (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {visible.map((b) => (
            <li key={b.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-zinc-100">{b.name}</span>
                <span className="text-xs text-zinc-500">{b.organizationId ? orgName.get(b.organizationId) ?? 'Organization' : 'No organization'}</span>
              </div>
              {b.aliases.length > 0 && <p className="text-xs text-zinc-500">Also known as {b.aliases.join(', ')}</p>}
              <p className="text-xs text-zinc-500">
                {b.seriesCount} series · {b.editionCount} {b.editionCount === 1 ? 'edition' : 'editions'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => { setEditing({ id: b.id, mode: 'rename' }); setDraft(b.name); }} disabled={busy}>
                  Rename
                </Button>
                <Button onClick={() => { setEditing({ id: b.id, mode: 'merge' }); setDraft(''); }} disabled={busy || (brands?.length ?? 0) < 2}>
                  Merge into another brand
                </Button>
                <select
                  aria-label={`Organization for ${b.name}`}
                  className={field}
                  value={b.organizationId ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    void run(`Organization set for ${b.name}.`, () => brandsApi.setOrganization(b.id, next));
                  }}
                >
                  <option value="">No organization</option>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              {editing?.id === b.id && editing.mode === 'rename' && (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(`Renamed to ${draft.trim()}.`, () => brandsApi.rename(b.id, draft));
                  }}
                >
                  <input aria-label="New brand name" className={field} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={80} />
                  <Button variant="primary" type="submit" disabled={busy || !draft.trim()}>
                    Save name
                  </Button>
                  <Button onClick={() => setEditing(null)}>Cancel</Button>
                </form>
              )}
              {editing?.id === b.id && editing.mode === 'merge' && (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const target = (brands ?? []).find((x) => x.id === draft);
                    if (!target) return;
                    void run(`Merged ${b.name} into ${target.name}.`, () => brandsApi.merge(b.id, target.id));
                  }}
                >
                  <select aria-label="Brand to keep" className={field} value={draft} onChange={(e) => setDraft(e.target.value)}>
                    <option value="">Pick the brand to keep</option>
                    {(brands ?? [])
                      .filter((x) => x.id !== b.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                  <Button variant="primary" type="submit" disabled={busy || !draft}>
                    Merge
                  </Button>
                  <Button onClick={() => setEditing(null)}>Cancel</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const ArchiveSeries: React.FC<{ query: string }> = ({ query }) => {
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [brandFilter, setBrandFilter] = useState('');
  const [debouncedBrand, setDebouncedBrand] = useState('');
  const [seriesList, setSeriesList] = useState<SeriesSummary[] | null>(null);
  const [detailSlug, setDetailSlug] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return parseManageParams(window.location.search).series ?? null;
  });
  const detailSlugRef = useRef<string | null>(detailSlug);
  detailSlugRef.current = detailSlug;

  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState<SeriesKind>('festival');
  const [newName, setNewName] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newCity, setNewCity] = useState('');
  const [newRegion, setNewRegion] = useState('');
  const [newCountry, setNewCountry] = useState('');
  const [newAliases, setNewAliases] = useState('');
  const [newLineupUrl, setNewLineupUrl] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seriesPastPlaces = useMemo(() => buildPastPlaces(seriesList ?? []), [seriesList]);
  const { setCityQuery, citySuggestions, mapOffer } = usePlaceAutofill({
    city: newCity,
    region: newRegion,
    country: newCountry,
    pastCities: seriesPastPlaces.cities,
    enabled: creating && newKind === 'festival',
  });

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedBrand(brandFilter), 300);
    return () => window.clearTimeout(t);
  }, [brandFilter]);

  const loadSeries = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await canonicalApi.series(debouncedQuery, debouncedBrand, signal);
        setSeriesList(res.series);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(messageOf(err));
      }
    },
    [debouncedQuery, debouncedBrand],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadSeries(controller.signal);
    return () => controller.abort();
  }, [loadSeries]);

  useEffect(() => {
    const syncFromUrl = () => {
      const params = parseManageParams(window.location.search);
      setDetailSlug(params.series ?? null);
    };
    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  const handleBackToSeries = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.state?.fromManageList) {
      window.history.back();
    } else {
      const url = buildManageUrl(
        { scope: 'archive', section: 'series', q: query || undefined },
        typeof window !== 'undefined' ? window.location.pathname : '/app',
      );
      window.history.replaceState(null, '', url);
      rememberManageSearch(new URL(url, window.location.origin).search);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [query]);

  const openSeries = (slug: string) => {
    const url = seriesUrl(slug, { q: query || undefined });
    window.history.pushState({ fromManageList: true }, '', url);
    rememberManageSearch(new URL(url, window.location.origin).search);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const createNewSeries = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || savingNew) return;
    setSavingNew(true);
    setError(null);
    setNotice(null);
    try {
      const created = await canonicalApi.createSeries({
        name: newName.trim(),
        kind: newKind,
        ...(newBrand.trim() ? { brand: newBrand.trim() } : {}),
        ...(newKind === 'festival' && newCity.trim() ? { city: newCity.trim() } : {}),
        ...(newKind === 'festival' && newRegion.trim() ? { region: newRegion.trim() } : {}),
        ...(newKind === 'festival' && newCountry.trim() ? { country: newCountry.trim() } : {}),
        ...(parseAliasText(newAliases).length ? { aliases: parseAliasText(newAliases) } : {}),
        ...(newLineupUrl.trim() ? { lineupUrl: newLineupUrl.trim() } : {}),
      });
      setNewKind('festival');
      setNewName('');
      setNewBrand('');
      setNewCity('');
      setNewRegion('');
      setNewCountry('');
      setNewAliases('');
      setNewLineupUrl('');
      setCreating(false);
      setNotice(`Created series "${created.name}".`);
      await loadSeries();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSavingNew(false);
    }
  };

  if (detailSlug) {
    return (
      <div className="space-y-4">
        <a
          href={buildManageUrl(
            { scope: 'archive', section: 'series', q: query || undefined },
            typeof window !== 'undefined' ? window.location.pathname : '/app',
          )}
          onClick={(e) => {
            if (isModifiedClick(e)) return;
            e.preventDefault();
            handleBackToSeries();
          }}
          className="text-sm text-violet-300 hover:text-violet-200"
        >
          ← Back to series
        </a>
        <SeriesDetail
          slug={detailSlug}
          allSeries={seriesList ?? []}
          onUpdated={() => void loadSeries()}
          onMerged={(keepSlug) => {
            void loadSeries();
            const url = seriesUrl(keepSlug, { q: query || undefined });
            window.history.replaceState({ fromManageList: window.history.state?.fromManageList }, '', url);
            rememberManageSearch(new URL(url, window.location.origin).search);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        />
      </div>
    );
  }

  const brands = [...new Set((seriesList ?? []).map((s) => s.brand).filter((b): b is string => Boolean(b)))].sort();

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Filter series by brand"
          placeholder="Filter by brand…"
          value={brandFilter}
          onChange={(e) => setBrandFilter(e.target.value)}
          list="archive-series-brands"
          className={`${field} w-48`}
        />
        <datalist id="archive-series-brands">
          {brands.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <Button onClick={() => setCreating((v) => !v)} className="ml-auto">
          {creating ? 'Cancel' : '+ New series'}
        </Button>
      </div>

      {creating && (
        <form onSubmit={(e) => void createNewSeries(e)} className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">Create canonical series</h3>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase text-zinc-500">Type</span>
              <Segmented
                label="Series type"
                value={newKind}
                onChange={setNewKind}
                options={[
                  { value: 'festival', label: 'Festival' },
                  { value: 'tour', label: 'Tour' },
                ]}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Name *</span>
              <input
                required
                className={`${field} w-full`}
                placeholder="e.g. EDC Las Vegas"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Brand (optional)</span>
              <SuggestInput
                className={`${field} w-full`}
                placeholder="e.g. Insomniac"
                value={newBrand}
                suggestions={brands}
                onChange={(e) => setNewBrand(e.target.value)}
                onPick={(b) => setNewBrand(b)}
              />
            </label>
            {newKind === 'festival' ? (
              <>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span className="block text-[11px] uppercase text-zinc-500">City (optional)</span>
                  <SuggestInput
                    className={`${field} w-full`}
                    placeholder="e.g. Las Vegas"
                    value={newCity}
                    suggestions={citySuggestions}
                    onChange={(e) => {
                      setNewCity(e.target.value);
                      setCityQuery(e.target.value);
                    }}
                    onPick={(picked) => {
                      const patch = cityPickPatch(picked, seriesPastPlaces.places, newCountry);
                      setNewCity(patch.city ?? '');
                      setNewRegion(patch.region ?? '');
                      if (patch.country !== undefined) setNewCountry(patch.country ?? '');
                      setCityQuery(patch.city ?? '');
                    }}
                  />
                </label>
                <div className="space-y-1 text-xs text-zinc-400">
                  <label className="block space-y-1">
                    <span className="block text-[11px] uppercase text-zinc-500">State (optional)</span>
                    <input
                      className={`${field} w-full`}
                      placeholder="NV, or the region"
                      value={newRegion}
                      onChange={(e) => setNewRegion(e.target.value)}
                    />
                  </label>
                  {mapOffer && (
                    <button
                      type="button"
                      onClick={() => {
                        if (mapOffer.patch.city) setNewCity(mapOffer.patch.city);
                        if (mapOffer.patch.region) setNewRegion(mapOffer.patch.region);
                        if (mapOffer.patch.country) setNewCountry(mapOffer.patch.country);
                      }}
                      className="block text-left text-xs text-violet-300 hover:underline"
                    >
                      Use “{mapOffer.value}” from {mapOffer.from}
                    </button>
                  )}
                </div>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span className="block text-[11px] uppercase text-zinc-500">Country (optional)</span>
                  <input
                    className={`${field} w-full`}
                    placeholder="e.g. United States"
                    value={newCountry}
                    onChange={(e) => setNewCountry(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <p className="text-xs text-zinc-400 sm:col-span-2">
                Tour series are location-agnostic; each stop carries its own venue and city.
              </p>
            )}
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Aliases (comma-separated)</span>
              <input
                className={`${field} w-full`}
                placeholder="e.g. EDC, EDCLV"
                value={newAliases}
                onChange={(e) => setNewAliases(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Lineup URL (optional)</span>
              <input
                className={`${field} w-full`}
                placeholder="https://…"
                value={newLineupUrl}
                onChange={(e) => setNewLineupUrl(e.target.value)}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={savingNew || !newName.trim()}>
              {savingNew && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create series
            </Button>
          </div>
        </form>
      )}

      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}

      {seriesList === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      ) : seriesList.length === 0 ? (
        <p className="text-sm text-zinc-400">{query || brandFilter ? 'No series match.' : 'No canonical series yet.'}</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {seriesList.map((s) => {
            const url = seriesUrl(s.slug, { q: query || undefined });
            const place = s.kind !== 'tour' ? formatPlaceLabel(s) : '';
            return (
              <li key={s.slug}>
                <a
                  href={url}
                  onClick={(e) => {
                    if (isModifiedClick(e)) return;
                    e.preventDefault();
                    openSeries(s.slug);
                  }}
                  className="flex w-full flex-wrap items-center gap-2 p-2.5 text-left text-sm hover:bg-zinc-900/60"
                >
                  <span className="font-medium text-zinc-100">{s.name}</span>
                  <Pill tone="neutral">{s.kind === 'tour' ? 'Tour' : 'Festival'}</Pill>
                  {s.brand && <Pill tone="accent">{s.brand}</Pill>}
                  {place && <span className="text-xs text-zinc-400">{place}</span>}
                  {s.aliases && s.aliases.length > 0 && (
                    <span className="text-xs text-zinc-400">AKA {s.aliases.join(', ')}</span>
                  )}
                  <span className="ml-auto text-xs text-zinc-400">
                    {s.editionCount} {s.editionCount === 1 ? 'edition' : 'editions'}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

const SeriesDetail: React.FC<{
  slug: string;
  allSeries: SeriesSummary[];
  onUpdated: () => void;
  onMerged: (keepSlug: string) => void;
}> = ({ slug, allSeries, onUpdated, onMerged }) => {
  const [series, setSeries] = useState<SeriesRecord | null>(null);
  const [editions, setEditions] = useState<CanonicalEditionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<SeriesKind>('festival');
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [country, setCountry] = useState('');
  const [aliases, setAliases] = useState('');
  const [lineupUrl, setLineupUrl] = useState('');
  const [sourcePriority, setSourcePriority] = useState<SourceType[]>([]);
  const [saving, setSaving] = useState(false);

  const [merging, setMerging] = useState(false);
  const [targetSlug, setTargetSlug] = useState('');
  const [mergeBusy, setMergeBusy] = useState(false);

  const seriesBrands = useMemo(
    () => [...new Set(allSeries.map((s) => s.brand).filter((b): b is string => Boolean(b)))].sort(),
    [allSeries],
  );
  const seriesPastPlaces = useMemo(() => buildPastPlaces(allSeries), [allSeries]);
  const editionsPlace = useMemo(() => unanimousPlace(editions), [editions]);
  const { setCityQuery, citySuggestions, mapOffer } = usePlaceAutofill({
    city,
    region,
    country,
    pastCities: seriesPastPlaces.cities,
    enabled: editing && kind === 'festival',
  });

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await canonicalApi.seriesEditions(slug);
      setSeries(res.series);
      setEditions(res.editions);
      setKind(res.series.kind === 'tour' ? 'tour' : 'festival');
      setName(res.series.name);
      setBrand(res.series.brand ?? '');
      setCity(res.series.city ?? '');
      setRegion(res.series.region ?? '');
      setCountry(res.series.country ?? '');
      setAliases((res.series.aliases ?? []).join(', '));
      setLineupUrl(res.series.lineupUrl ?? '');
      setSourcePriority(res.series.sourcePriority ?? []);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const togglePriority = (src: SourceType) => {
    setSourcePriority((prev) => (prev.includes(src) ? prev.filter((x) => x !== src) : [...prev, src]));
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await canonicalApi.updateSeries(slug, {
        name: name.trim(),
        kind,
        brand: brand.trim() || null,
        ...(kind === 'festival'
          ? {
              city: city.trim() || null,
              region: region.trim() || null,
              country: country.trim() || null,
            }
          : { city: null, region: null, country: null }),
        aliases: parseAliasText(aliases),
        lineupUrl: lineupUrl.trim() || null,
        sourcePriority,
      });
      setSeries(updated);
      setEditing(false);
      setNotice('Series updated.');
      onUpdated();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const runMerge = async () => {
    if (!targetSlug || mergeBusy) return;
    setMergeBusy(true);
    setError(null);
    try {
      await canonicalApi.mergeSeries(targetSlug, slug);
      onMerged(targetSlug);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setMergeBusy(false);
    }
  };

  if (loading && !series) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
  if (!series) return <p role="alert" className="text-sm text-rose-300">{error ?? 'Series not found.'}</p>;

  const mergeTargets = allSeries.filter((s) => s.slug !== slug);
  const seriesPlaceLabel = series.kind !== 'tour' ? formatPlaceLabel(series) : '';
  const seriesPlaceEmpty = !city.trim() && !region.trim() && !country.trim();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-zinc-50">{series.name}</h3>
            <Pill tone="neutral">{series.kind === 'tour' ? 'Tour' : 'Festival'}</Pill>
            {series.brand && <Pill tone="accent">{series.brand}</Pill>}
            {seriesPlaceLabel && <span className="text-xs text-zinc-400">{seriesPlaceLabel}</span>}
          </div>
          <p className="text-xs text-zinc-500">Slug: {series.slug}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!editing && <Button onClick={() => setEditing(true)}>Edit series</Button>}
          {mergeTargets.length > 0 && (
            <Button onClick={() => setMerging((v) => !v)}>
              {merging ? 'Cancel merge' : 'Merge into…'}
            </Button>
          )}
        </div>
      </div>

      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}

      {merging && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm">
          <p className="font-semibold text-zinc-100">Merge "{series.name}" into another series</p>
          <p className="text-xs text-zinc-400">
            All attached editions move onto the target series, and "{series.name}" plus its aliases are kept as aliases on the target.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Target series"
              value={targetSlug}
              onChange={(e) => setTargetSlug(e.target.value)}
              className={`${field} min-w-[14rem] flex-1`}
            >
              <option value="">Choose target series…</option>
              {mergeTargets.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}{s.brand ? ` (${s.brand})` : ''} · {s.editionCount} editions
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={() => void runMerge()} disabled={!targetSlug || mergeBusy}>
              {mergeBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Merge series
            </Button>
          </div>
        </div>
      )}

      {editing ? (
        <form onSubmit={(e) => void saveEdit(e)} className="space-y-3 rounded-lg border border-zinc-800 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase text-zinc-500">Type</span>
            <Segmented
              label="Series type"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'festival', label: 'Festival' },
                { value: 'tour', label: 'Tour' },
              ]}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Name</span>
              <input required className={`${field} w-full`} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Brand</span>
              <SuggestInput
                className={`${field} w-full`}
                placeholder="Optional"
                value={brand}
                suggestions={seriesBrands}
                onChange={(e) => setBrand(e.target.value)}
                onPick={(b) => setBrand(b)}
              />
            </label>
            {kind === 'festival' ? (
              <>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span className="block text-[11px] uppercase text-zinc-500">City</span>
                  <SuggestInput
                    className={`${field} w-full`}
                    placeholder="Optional"
                    value={city}
                    suggestions={citySuggestions}
                    onChange={(e) => {
                      setCity(e.target.value);
                      setCityQuery(e.target.value);
                    }}
                    onPick={(picked) => {
                      const patch = cityPickPatch(picked, seriesPastPlaces.places, country);
                      setCity(patch.city ?? '');
                      setRegion(patch.region ?? '');
                      if (patch.country !== undefined) setCountry(patch.country ?? '');
                      setCityQuery(patch.city ?? '');
                    }}
                  />
                </label>
                <div className="space-y-1 text-xs text-zinc-400">
                  <label className="block space-y-1">
                    <span className="block text-[11px] uppercase text-zinc-500">State</span>
                    <input
                      className={`${field} w-full`}
                      placeholder="NV, or the region"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                    />
                  </label>
                  {mapOffer && (
                    <button
                      type="button"
                      onClick={() => {
                        if (mapOffer.patch.city) setCity(mapOffer.patch.city);
                        if (mapOffer.patch.region) setRegion(mapOffer.patch.region);
                        if (mapOffer.patch.country) setCountry(mapOffer.patch.country);
                      }}
                      className="block text-left text-xs text-violet-300 hover:underline"
                    >
                      Use “{mapOffer.value}” from {mapOffer.from}
                    </button>
                  )}
                  {seriesPlaceEmpty && editionsPlace && (
                    <button
                      type="button"
                      onClick={() => {
                        setCity(editionsPlace.city ?? '');
                        setRegion(editionsPlace.region ?? '');
                        setCountry(editionsPlace.country ?? '');
                      }}
                      className="block text-left text-xs text-violet-300 hover:underline"
                    >
                      Use “{editionsPlace.label}” from attached editions
                    </button>
                  )}
                </div>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span className="block text-[11px] uppercase text-zinc-500">Country</span>
                  <input
                    className={`${field} w-full`}
                    placeholder="Optional"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <p className="text-xs text-zinc-400 sm:col-span-2">
                Tour series are location-agnostic; each stop carries its own venue and city.
              </p>
            )}
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Aliases (comma-separated)</span>
              <input className={`${field} w-full`} placeholder="e.g. EDC, EDCLV" value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">Lineup URL</span>
              <input className={`${field} w-full`} placeholder="https://…" value={lineupUrl} onChange={(e) => setLineupUrl(e.target.value)} />
            </label>
          </div>
          <div className="space-y-1">
            <span className="block text-[11px] uppercase text-zinc-500">Source priority</span>
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_PRIORITY_OPTIONS.map((src) => {
                const active = sourcePriority.includes(src);
                return (
                  <button
                    key={src}
                    type="button"
                    aria-pressed={active}
                    onClick={() => togglePriority(src)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      active
                        ? 'border-violet-400 bg-violet-500/20 text-violet-100'
                        : 'border-zinc-700 text-zinc-300 hover:border-violet-500'
                    }`}
                  >
                    {SOURCE_LABELS[src] ?? src}
                    {active ? ` #${sourcePriority.indexOf(src) + 1}` : ''}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save series'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
          </div>
        </form>
      ) : (
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[11px] uppercase text-zinc-500">Aliases</dt>
            <dd className={series.aliases?.length ? 'text-zinc-200' : 'italic text-zinc-500'}>
              {series.aliases?.length ? series.aliases.join(', ') : 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase text-zinc-500">Lineup URL</dt>
            <dd className="truncate">
              {series.lineupUrl ? (
                <a href={series.lineupUrl} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">
                  {series.lineupUrl}
                </a>
              ) : (
                <span className="italic text-zinc-500">Not set</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase text-zinc-500">Place</dt>
            <dd className={seriesPlaceLabel ? 'text-zinc-200' : 'italic text-zinc-500'}>
              {series.kind === 'tour' ? 'Location-agnostic (tour)' : seriesPlaceLabel || 'Not set'}
            </dd>
          </div>
          {series.sourcePriority && series.sourcePriority.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-[11px] uppercase text-zinc-500">Source priority</dt>
              <dd className="text-zinc-200">
                {series.sourcePriority.map((s) => SOURCE_LABELS[s] ?? s).join(' → ')}
              </dd>
            </div>
          )}
        </dl>
      )}

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-zinc-200">
          Editions ({editions.length})
        </h4>
        {editions.length === 0 ? (
          <p className="text-sm text-zinc-400">No editions attached to this series yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {editions.map((e) => {
              const url = editionUrl(e.id);
              const dateText = e.weekends.length > 1
                ? e.weekends.map((w) => weekendLabel(w, 'WK')).join(' · ')
                : e.startDate ?? String(e.year);
              return (
                <li key={e.id}>
                  <a
                    href={url}
                    onClick={(ev) => {
                      if (isModifiedClick(ev)) return;
                      ev.preventDefault();
                      window.history.pushState({ fromManageList: true }, '', url);
                      rememberManageSearch(new URL(url, window.location.origin).search);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                    className="flex w-full flex-wrap items-baseline gap-x-3 p-2.5 text-left text-sm hover:bg-zinc-900/60"
                  >
                    <span className="font-medium text-zinc-100">{e.name}</span>
                    <span className="text-xs text-zinc-400">
                      {[dateText, e.venue, e.city].filter(Boolean).join(' · ')}
                    </span>
                    <span className="ml-auto text-xs text-zinc-400">
                      {e.performanceCount} billed · {editionStatusWords(e.status).split(' (')[0].toLowerCase()}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};

const ArchiveEditions: React.FC<{ query: string; status: EditionStatus }> = ({ query, status }) => {
  // The page is the first 200 matches of the filter (searched across the whole catalog); `total` counts every match.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [page, setPage] = useState<{ editions: CanonicalEditionSummary[]; total: number; hasMore: boolean } | null>(null);
  const [detail, setDetail] = useState<Edition | null>(null);
  const detailRef = useRef<Edition | null>(null);
  detailRef.current = detail;
  // Edit lineup: the review screen, seeded from the saved edition (canonical mode).
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Merge selection mode
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mergeEditions, setMergeEditions] = useState<Edition[] | null>(null);
  const [loadingMerge, setLoadingMerge] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setPage(await canonicalApi.editions(debouncedQuery, status, signal));
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(messageOf(err));
      }
    },
    [debouncedQuery, status],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const openEdition = useCallback(async (id: string) => {
    setError(null);
    try {
      setDetail((await canonicalApi.edition(id)).edition);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const handleBackToEditions = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.state?.fromManageList) {
      window.history.back();
    } else {
      const url = buildManageUrl(
        { scope: 'archive', section: 'editions', status, q: query || undefined },
        typeof window !== 'undefined' ? window.location.pathname : '/app',
      );
      window.history.replaceState(null, '', url);
      rememberManageSearch(new URL(url, window.location.origin).search);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [status, query]);

  useEffect(() => {
    const syncFromUrl = () => {
      const params = parseManageParams(window.location.search);
      if (params.edition) {
        if (detailRef.current?.id !== params.edition) {
          void openEdition(params.edition);
        }
      } else if (detailRef.current) {
        setDetail(null);
      }
    };
    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, [openEdition]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startSelectedMerge = async () => {
    if (selectedIds.size < 2 || loadingMerge) return;
    setLoadingMerge(true);
    setError(null);
    try {
      const loaded = await Promise.all([...selectedIds].map((id) => canonicalApi.edition(id).then((r) => r.edition)));
      setMergeEditions(loaded);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoadingMerge(false);
    }
  };

  if (detail && editing) {
    return (
      <LineupReview
        job={reviewSubjectFromEdition(detail)}
        mode="canonical"
        edition={detail}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          void openEdition(detail.id);
        }}
      />
    );
  }

  if (detail) {
    return (
      <div className="space-y-4">
        <a
          href={buildManageUrl(
            { scope: 'archive', section: 'editions', status, q: query || undefined },
            typeof window !== 'undefined' ? window.location.pathname : '/app',
          )}
          onClick={(e) => {
            if (isModifiedClick(e)) return;
            e.preventDefault();
            handleBackToEditions();
          }}
          className="text-sm text-violet-300 hover:text-violet-200"
        >
          ← Back to editions
        </a>
        <EditionDetail
          edition={detail}
          onEditLineup={() => setEditing(true)}
          onFactsSaved={setDetail}
          onStartMerge={() => setMergeEditions([detail])}
        />
        {mergeEditions && (
          <MergeEditionModal
            initialEditions={mergeEditions}
            onClose={() => setMergeEditions(null)}
            onMerged={(kept) => {
              setMergeEditions(null);
              void load();
              const url = editionUrl(kept.id, { status, q: query || undefined });
              window.history.replaceState({ fromManageList: window.history.state?.fromManageList }, '', url);
              rememberManageSearch(new URL(url, window.location.origin).search);
              setDetail(kept);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <section className="space-y-2">
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {page === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      ) : page.editions.length === 0 ? (
        <p className="text-sm text-zinc-400">{query || status !== 'all' ? 'No editions match.' : 'No editions yet. Ingest one under Lookups.'}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-zinc-400" role="status">
              {page.hasMore ? `Showing ${page.editions.length} of ${page.total}` : `${page.total} ${page.total === 1 ? 'edition' : 'editions'}`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {selectMode && (
                <>
                  <span className="text-xs text-zinc-300">{selectedIds.size} selected</span>
                  <Button
                    variant="primary"
                    disabled={selectedIds.size < 2 || loadingMerge}
                    onClick={() => void startSelectedMerge()}
                  >
                    {loadingMerge && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Merge selected…
                  </Button>
                </>
              )}
              <Button
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelectedIds(new Set());
                }}
              >
                {selectMode ? 'Cancel' : 'Select to merge'}
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {page.editions.map((e) => {
              const url = editionUrl(e.id, { status, q: query || undefined });
              const checked = selectedIds.has(e.id);
              const dateSummary = e.weekends.length > 1
                ? `${e.weekends.length} weekends`
                : e.startDate;
              return (
                <li key={e.id} className="flex items-center">
                  {selectMode && (
                    <label className="flex cursor-pointer items-center pl-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelect(e.id)}
                        aria-label={`Select ${e.name}`}
                        className="h-4 w-4 accent-violet-500"
                      />
                    </label>
                  )}
                  <a
                    href={url}
                    onClick={(eNav) => {
                      if (selectMode) {
                        eNav.preventDefault();
                        toggleSelect(e.id);
                        return;
                      }
                      if (isModifiedClick(eNav)) return;
                      eNav.preventDefault();
                      window.history.pushState({ fromManageList: true }, '', url);
                      rememberManageSearch(new URL(url, window.location.origin).search);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                    className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 p-2.5 text-left text-sm hover:bg-zinc-900/60"
                  >
                    <span className="font-medium text-zinc-100">{e.name}</span>
                    {e.seriesName && (
                      <span className="text-xs text-violet-300/90">
                        {e.seriesName}{e.seriesBrand ? ` · ${e.seriesBrand}` : ''}
                      </span>
                    )}
                    <span className="text-xs text-zinc-400">{[dateSummary, e.venue, e.city].filter(Boolean).join(' · ') || 'Details missing'}</span>
                    <span className="ml-auto text-xs text-zinc-400">{e.performanceCount} billed · {editionStatusWords(e.status).split(' (')[0].toLowerCase()}{e.hasSetTimes ? ' · set times' : ''}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {mergeEditions && (
        <MergeEditionModal
          initialEditions={mergeEditions}
          onClose={() => setMergeEditions(null)}
          onMerged={(kept) => {
            setMergeEditions(null);
            setSelectMode(false);
            setSelectedIds(new Set());
            void load();
            const url = editionUrl(kept.id, { status, q: query || undefined });
            window.history.pushState({ fromManageList: true }, '', url);
            rememberManageSearch(new URL(url, window.location.origin).search);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        />
      )}
    </section>
  );
};

const ArchiveLookups: React.FC = () => {
  const [name, setName] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookups, setLookups] = useState<LookupJob[] | null>(null);
  const [reviewing, setReviewing] = useState<LookupJob | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const loadLookups = useCallback(async () => {
    try {
      setLookups(await canonicalApi.lookups());
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void loadLookups();
  }, [loadLookups]);

  // While any lookup is queued, running or waiting for quota, the list checks again every 20 seconds.
  const anyActive = (lookups ?? []).some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = window.setInterval(() => void loadLookups(), 20_000);
    return () => window.clearInterval(timer);
  }, [anyActive, loadLookups]);

  const ingest = async () => {
    setError(null);
    const y = Number(year);
    if (!name.trim()) return setError('Enter the event or festival name.');
    if (!Number.isInteger(y)) return setError('Enter a four-digit year.');
    setBusy(true);
    try {
      const started = await canonicalApi.ingest({ name: name.trim(), year: y, lineupUrl: url.trim() || undefined });
      // Show the new job at once, at the top of the list, without waiting for the next poll.
      setLookups((prev) => [started, ...(prev ?? []).filter((j) => j.id !== started.id)]);
      setName('');
      setUrl('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (id: string) => {
    setError(null);
    setRetrying(id);
    try {
      const latest = await lineupApi.retry(id);
      setLookups((prev) => (prev ?? []).map((j) => (j.id === id ? latest : j)));
      void loadLookups();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRetrying(null);
    }
  };

  if (reviewing) {
    return (
      <LineupReview
        job={reviewing}
        mode="canonical"
        onClose={() => setReviewing(null)}
        onSaved={() => {
          setReviewing(null);
          void loadLookups();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <h3 className="text-sm font-semibold text-zinc-100">Ingest a canonical lineup</h3>
        <p className="text-xs text-zinc-400">Finds the lineup for an event you did not attend. Nothing is added to your log.</p>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Event or festival name" className={`${field} min-w-[12rem] flex-1`} placeholder="Event or festival name" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Year" className={`${field} w-24`} inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          <input aria-label="Lineup URL (optional)" className={`${field} min-w-[12rem] flex-1`} placeholder="Lineup URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
          {name.trim() && /^\d{4}$/.test(year) && (
            <VersionPicker
              key={`${name.trim()}-${year}`}
              load={async () => canonicalApi.versions(name.trim(), Number(year))}
              onPick={(v) => setUrl(v.url)}
            />
          )}
          <button onClick={ingest} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Ingest
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      </div>

      <section className="space-y-2" aria-labelledby="lookups-heading">
        <h3 id="lookups-heading" className="text-sm font-semibold text-zinc-100">Lookups</h3>
        {lookups === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : lookups.length === 0 ? (
          <p className="text-sm text-zinc-400">No lookups yet. An ingest shows here at once.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {lookups.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
                <span className="font-medium text-zinc-100">{j.input.eventName}</span>
                <span className="text-xs text-zinc-400">{j.input.year}</span>
                <Pill tone={STATUS_TONE[j.status]}>{STATUS_WORDS[j.status]}</Pill>
                {j.status === 'failed' && j.lastError && <span className="basis-full text-xs text-rose-300">{j.lastError}</span>}
                {j.status === 'waiting_quota' && j.waitingReason && <span className="basis-full text-xs text-amber-200">{j.waitingReason}</span>}
                <span className="ml-auto flex gap-2">
                  {j.status === 'needs_review' && <Button variant="primary" onClick={() => setReviewing(j)}>Review</Button>}
                  {canRetry(j) && (
                    <Button onClick={() => void retry(j.id)} disabled={retrying === j.id}>
                      {retrying === j.id && <Loader2 className="h-4 w-4 animate-spin" />} Retry
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// The Changes list (slice 8.10, owner only): canonical changes, newest first, 50 a page through Load more.
// Undo is offered while a change is not undone. A refused Undo (409) leaves the row as it was and shows the server's message.
type ChangesList = { rows: CanonicalChangeRow[]; nextCursor: string | null; hasMore: boolean };

const ArchiveChanges: React.FC = () => {
  const [list, setList] = useState<ChangesList | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Reloads the first page. Entries already loaded past it stay, in order, so a refresh never shrinks the list.
  const loadFirst = useCallback(async () => {
    const first = await canonicalApi.changes();
    setList((prev) => {
      const fresh: ChangesList = { rows: first.changes, nextCursor: first.nextCursor, hasMore: first.hasMore };
      if (!prev) return fresh;
      const shown = new Set(first.changes.map((r) => r.id));
      const beyond = prev.rows.filter((r) => !shown.has(r.id));
      return beyond.length === 0 ? fresh : { rows: [...first.changes, ...beyond], nextCursor: prev.nextCursor, hasMore: prev.hasMore };
    });
  }, []);

  useEffect(() => {
    loadFirst().catch((err) => setError(messageOf(err)));
  }, [loadFirst]);

  // Appends the next page from the cursor. A failure keeps every row already shown.
  const loadMore = async () => {
    const cursor = list?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await canonicalApi.changes(cursor);
      setList((prev) =>
        prev && {
          rows: [...prev.rows, ...page.changes.filter((r) => !prev.rows.some((x) => x.id === r.id))],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const undo = async (row: CanonicalChangeRow) => {
    setBusyId(row.id);
    setError(null);
    setDone(null);
    try {
      const r = await canonicalApi.undoChange(row.id);
      const undoneAt = r.entry?.undoneAt ?? r.undoneAt ?? new Date().toISOString();
      setList((prev) => prev && { ...prev, rows: prev.rows.map((x) => (x.id === row.id ? { ...x, undoneAt } : x)) });
      setDone(`Undid: ${row.summary}.`);
      await loadFirst();
    } catch (err) {
      // A 409 (UndoConflictError) keeps this row unchanged. The message is the server's.
      setError(err instanceof UndoConflictError ? err.message : messageOf(err));
    } finally {
      setBusyId(null);
    }
  };

  const rows = list?.rows ?? [];
  return (
    <section className="space-y-3">
      <Callout id="archive-changes">
        Undo puts the records back as they were before a change. A change can only be undone after the later changes to the same records.
      </Callout>
      {done && <Notice tone="success">{done}</Notice>}
      {error && <Notice tone="warning">{error}</Notice>}
      {list === null ? (
        error ? null : <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-400">No changes yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {rows.map((r) => (
            <li key={r.id} className="space-y-1 p-2.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={r.undoneAt ? 'text-zinc-500 line-through' : 'text-zinc-100'}>{r.summary}</span>
                <span className="text-[11px] text-zinc-400">{when(r.time)}</span>
                {r.undoneAt ? (
                  <span className="text-[11px] text-zinc-400">Undone {when(r.undoneAt)}</span>
                ) : (
                  <span className="ml-auto">
                    <Button onClick={() => void undo(r)} disabled={busyId !== null}>
                      {busyId === r.id && <Loader2 className="h-4 w-4 animate-spin" />} Undo
                    </Button>
                  </span>
                )}
              </div>
              <p className={`text-xs ${r.undoneAt ? 'text-zinc-500 line-through' : 'text-zinc-400'}`}>
                {r.before} → {r.after}
              </p>
            </li>
          ))}
        </ul>
      )}
      {list?.hasMore && (
        <div>
          <Button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />} Load more
          </Button>
        </div>
      )}
    </section>
  );
};

const BILLING_WORDS: Record<string, string> = { headliner: 'Headliner', support: 'Support' };

// One edition as a record (owner only). Missing data reads "Not known"; nothing is filled in.
// Each act shows its billing role, B2B partners, set, day, stage and set times, and each source
// shows its quote, or the "Admin curated" badge for the owner's own curation.
const EditionDetail: React.FC<{
  edition: Edition;
  onEditLineup: () => void;
  onFactsSaved: (edition: Edition) => void;
  onStartMerge?: () => void;
}> = ({ edition, onEditLineup, onFactsSaved, onStartMerge }) => {
  const [editingFacts, setEditingFacts] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // The last verify or undo result, kept with its edition id so it never shows on another edition.
  const [verifyNote, setVerifyNote] = useState<{ editionId: string; text: string; changeId?: string } | null>(null);
  const verifyError = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');
  const verifyEdition = async () => {
    setVerifying(true);
    try {
      const r = await canonicalApi.verifyEdition(edition.id);
      setVerifyNote({ editionId: edition.id, text: 'Verified. Members can now see it.', changeId: r.changeId ?? undefined });
      onFactsSaved({ ...edition, status: 'verified' });
    } catch (e) {
      setVerifyNote({ editionId: edition.id, text: `Could not verify. ${verifyError(e)}` });
    } finally {
      setVerifying(false);
    }
  };
  const undoVerify = async (changeId: string) => {
    setVerifying(true);
    try {
      await inboxApi.undo(changeId, edition.id);
      setVerifyNote({ editionId: edition.id, text: 'Undone. The edition is provisional again.' });
      onFactsSaved({ ...edition, status: 'provisional' });
    } catch (e) {
      // Keep the change id so Undo can be tried again.
      setVerifyNote({ editionId: edition.id, text: `Could not undo. ${verifyError(e)}`, changeId });
    } finally {
      setVerifying(false);
    }
  };
  // Clashfinder "Find lineup" (slice 2.10): festival editions with no lineup only. The job goes to Lookups for review.
  const [findingLineup, setFindingLineup] = useState(false);
  const [lineupNote, setLineupNote] = useState<{ editionId: string; text: string } | null>(null);
  const canFindLineup = edition.seriesKind === 'festival' && edition.performances.length === 0;
  const findLineup = async () => {
    setFindingLineup(true);
    try {
      const res = await fetch(`/api/manage/canonical/editions/${encodeURIComponent(edition.id)}/find-lineup`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`);
      setLineupNote({ editionId: edition.id, text: 'Clashfinder lookup started. Review the result under Lookups.' });
    } catch (e) {
      setLineupNote({ editionId: edition.id, text: `Could not start the lookup. ${verifyError(e)}` });
    } finally {
      setFindingLineup(false);
    }
  };
  const lineupStatus = lineupNote?.editionId === edition.id ? lineupNote : null;
  const note = verifyNote?.editionId === edition.id ? verifyNote : null;
  const names = new Map(edition.performances.map((p) => [p.artistKey, p.name]));
  const dates = [edition.startDate, edition.endDate && edition.endDate !== edition.startDate ? `to ${edition.endDate}` : null].filter(Boolean).join(' ');
  const inheritSeriesPlace = edition.seriesKind !== 'tour';
  const facts: Array<{ label: string; value: string | undefined; fromSeries?: boolean }> = [
    { label: 'Year', value: String(edition.year) },
    { label: 'Dates', value: dates || undefined },
    { label: 'Venue', value: edition.venue },
    {
      label: 'City',
      value: edition.city || (inheritSeriesPlace ? edition.seriesCity : undefined),
      fromSeries: !edition.city && inheritSeriesPlace && Boolean(edition.seriesCity),
    },
    {
      label: 'Region',
      value: edition.region || (inheritSeriesPlace ? edition.seriesRegion : undefined),
      fromSeries: !edition.region && inheritSeriesPlace && Boolean(edition.seriesRegion),
    },
    {
      label: 'Country',
      value: edition.country || (inheritSeriesPlace ? edition.seriesCountry : undefined),
      fromSeries: !edition.country && inheritSeriesPlace && Boolean(edition.seriesCountry),
    },
    { label: 'Status', value: editionStatusWords(edition.status) },
  ];
  const seriesHref = edition.seriesSlug ? seriesUrl(edition.seriesSlug) : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-zinc-50">{edition.name}</h3>
          <p className="text-xs text-zinc-500">Catalog record. Your personal log is not changed.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {edition.status === 'provisional' && (
            <Button variant="primary" onClick={() => void verifyEdition()} disabled={verifying}>
              {verifying && <Loader2 className="h-4 w-4 animate-spin" />} Verify for everyone
            </Button>
          )}
          {!editingFacts && <Button onClick={() => setEditingFacts(true)}>Edit facts</Button>}
          {canFindLineup && (
            <Button onClick={() => void findLineup()} disabled={findingLineup}>
              {findingLineup && <Loader2 className="h-4 w-4 animate-spin" />} Find lineup
            </Button>
          )}
          <Button onClick={onEditLineup}>Edit lineup</Button>
          {onStartMerge && <Button onClick={onStartMerge}>Merge with…</Button>}
        </div>
      </div>
      {lineupStatus && <p className="text-sm text-zinc-300" role="status">{lineupStatus.text}</p>}
      {(edition.status === 'provisional' || note) && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {edition.status === 'provisional' && <span className="text-xs text-zinc-500">Members entered this. Verifying makes it autofill for everyone.</span>}
          {note && (
            <>
              <span className="text-zinc-300" role="status">{note.text}</span>
              {note.changeId && (
                <button onClick={() => void undoVerify(note.changeId!)} disabled={verifying} className="text-violet-300 hover:text-violet-200 disabled:opacity-40">
                  Undo
                </button>
              )}
            </>
          )}
        </div>
      )}
      {editingFacts ? (
        <EditionFactsForm
          edition={edition}
          onCancel={() => setEditingFacts(false)}
          onSaved={(saved) => {
            setEditingFacts(false);
            onFactsSaved(saved);
          }}
        />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-[11px] uppercase text-zinc-500">Series</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {edition.seriesSlug ? (
                  <>
                    {seriesHref ? (
                      <a
                        href={seriesHref}
                        onClick={(e) => {
                          if (isModifiedClick(e)) return;
                          e.preventDefault();
                          window.history.pushState({ fromManageList: true }, '', seriesHref);
                          rememberManageSearch(new URL(seriesHref, window.location.origin).search);
                          window.dispatchEvent(new PopStateEvent('popstate'));
                        }}
                        className="text-violet-300 hover:underline"
                      >
                        {edition.seriesName ?? edition.seriesSlug}
                      </a>
                    ) : (
                      <span className="text-zinc-100">{edition.seriesName ?? edition.seriesSlug}</span>
                    )}
                    {edition.seriesBrand && <Pill tone="accent">{edition.seriesBrand}</Pill>}
                  </>
                ) : (
                  <span className="italic text-zinc-500">None</span>
                )}
              </dd>
            </div>
            {facts.map((item) => (
              <div key={item.label}>
                <dt className="text-[11px] uppercase text-zinc-500">{item.label}</dt>
                <dd className={item.value ? 'text-zinc-100' : 'italic text-zinc-500'}>
                  {item.value ?? 'Not known'}
                  {item.fromSeries && <span className="ml-1 text-xs text-zinc-400">(from series)</span>}
                </dd>
              </div>
            ))}
          </dl>
          {edition.weekends && edition.weekends.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] uppercase text-zinc-500">Weekends</p>
              <div className="flex flex-wrap gap-1.5">
                {edition.weekends.map((w) => (
                  <Pill key={w.weekend} tone="neutral">
                    {weekendLabel(w)}
                  </Pill>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-zinc-400">
            Facts source: {edition.factSourceNote ? <span className="text-zinc-200">{edition.factSourceNote}</span> : <span className="italic text-zinc-500">No source note for these facts yet.</span>}
          </p>
        </>
      )}
      {edition.performances.length === 0 ? (
        <p className="text-sm text-zinc-400">No acts recorded for this edition.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {edition.performances.map((p) => (
            <ActRecord key={p.artistKey} act={p} partners={(p.b2b ?? []).map((k) => names.get(k) ?? k)} />
          ))}
        </ul>
      )}
    </div>
  );
};

// Edition facts (GA4, owner only). Name, dates, venue and city are edited with a required source note.
// The diff (old to new) is shown before Save, which stays disabled until a fact changes and a note is given.
// A blank fact is sent as blank (null) and reads "Not known"; nothing is defaulted.
const FACT_FIELDS: Array<{ key: 'name' | 'startDate' | 'endDate' | 'venue' | 'city' | 'region' | 'country'; label: string; type?: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'startDate', label: 'Start date', type: 'date' },
  { key: 'endDate', label: 'End date', type: 'date' },
  { key: 'venue', label: 'Venue' },
  { key: 'city', label: 'City' },
  { key: 'region', label: 'Region' },
  { key: 'country', label: 'Country' },
];

function serializeWeekends(list: EditionWeekend[]): string {
  return JSON.stringify(
    list
      .map((w) => ({
        weekend: w.weekend,
        startDate: w.startDate.trim(),
        endDate: w.endDate?.trim() || undefined,
      }))
      .sort((a, b) => a.weekend - b.weekend),
  );
}

const EditionFactsForm: React.FC<{ edition: Edition; onCancel: () => void; onSaved: (edition: Edition) => void }> = ({ edition, onCancel, onSaved }) => {
  const stored = (key: (typeof FACT_FIELDS)[number]['key']): string => (edition[key] ?? '') as string;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(FACT_FIELDS.map((f) => [f.key, stored(f.key)])));
  const [seriesSlug, setSeriesSlug] = useState<string>(edition.seriesSlug ?? '');
  const [seriesList, setSeriesList] = useState<SeriesSummary[]>([]);
  const [newSeriesOpen, setNewSeriesOpen] = useState(false);
  const [newSeriesName, setNewSeriesName] = useState('');
  const [newSeriesBrand, setNewSeriesBrand] = useState('');
  const [creatingSeries, setCreatingSeries] = useState(false);

  const initialWeekends = edition.weekends ?? [];
  const [weekendsMode, setWeekendsMode] = useState<'single' | 'multi'>(initialWeekends.length > 0 ? 'multi' : 'single');
  const [weekends, setWeekends] = useState<EditionWeekend[]>(() =>
    initialWeekends.map((w) => ({ weekend: w.weekend, startDate: w.startDate, ...(w.endDate ? { endDate: w.endDate } : {}) })),
  );
  const [draftBadges, setDraftBadges] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lineupStatus, setLineupStatus] = useState<LineupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [geminiChecking, setGeminiChecking] = useState(false);
  const [details, setDetails] = useState<EventDetails | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const seriesBrands = useMemo(
    () => [...new Set(seriesList.map((s) => s.brand).filter((b): b is string => Boolean(b)))].sort(),
    [seriesList],
  );
  const seriesPastPlaces = useMemo(() => buildPastPlaces(seriesList), [seriesList]);
  const { setCityQuery, citySuggestions, mapOffer } = usePlaceAutofill({
    city: values.city,
    region: values.region,
    country: values.country,
    pastCities: seriesPastPlaces.cities,
  });

  const selectedSeries = seriesList.find((s) => s.slug === seriesSlug);
  const effectiveSeriesKind = selectedSeries?.kind ?? (seriesSlug === edition.seriesSlug ? edition.seriesKind : undefined);
  const effectiveSeriesCity = selectedSeries?.city ?? (seriesSlug === edition.seriesSlug ? edition.seriesCity : undefined);
  const effectiveSeriesRegion = selectedSeries?.region ?? (seriesSlug === edition.seriesSlug ? edition.seriesRegion : undefined);
  const effectiveSeriesCountry = selectedSeries?.country ?? (seriesSlug === edition.seriesSlug ? edition.seriesCountry : undefined);
  const seriesPlaceLabel =
    effectiveSeriesKind !== 'tour'
      ? formatPlaceLabel({ city: effectiveSeriesCity, region: effectiveSeriesRegion, country: effectiveSeriesCountry })
      : '';
  const editionPlaceEmpty = !values.city?.trim() && !values.region?.trim() && !values.country?.trim();

  useEffect(() => {
    let alive = true;
    lineupApi.status().then(
      (st) => {
        if (alive) setLineupStatus(st);
      },
      () => {
        if (alive) setLineupStatus(null);
      },
    );
    canonicalApi.series().then(
      (res) => {
        if (alive) setSeriesList(res.series);
      },
      () => {
        if (alive) setSeriesList([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const runResearch = async (useGemini: boolean) => {
    if (useGemini) {
      setGeminiChecking(true);
    } else {
      setChecking(true);
    }
    setCheckError(null);
    try {
      const res = await canonicalApi.researchEdition(edition.id, {
        name: values.name,
        startDate: values.startDate,
        endDate: values.endDate,
        venue: values.venue,
        city: values.city,
        useGemini,
      });
      setDetails(res);
    } catch (err) {
      setCheckError(messageOf(err));
    } finally {
      if (useGemini) {
        setGeminiChecking(false);
      } else {
        setChecking(false);
      }
    }
  };

  const handlePick = (id: string) => {
    setDetails((prev) => {
      if (!prev) return null;
      const picked = prev.candidates.find((c) => c.id === id);
      const remaining = prev.candidates.filter((c) => c.id !== id);
      return {
        ...prev,
        status: 'resolved',
        candidates: picked ? [picked, ...remaining] : prev.candidates,
      };
    });
  };

  const handleNone = () => {
    setDetails((prev) => (prev ? { ...prev, status: 'none' } : null));
  };

  const confirmed = details?.status === 'matched' || details?.status === 'resolved' ? details.candidates[0] : undefined;
  const checkFields: Array<{ key: 'startDate' | 'endDate' | 'venue' | 'city' | 'country'; label: string }> = [
    { key: 'startDate', label: 'Start date' },
    { key: 'endDate', label: 'End date' },
    { key: 'venue', label: 'Venue' },
    { key: 'city', label: 'City' },
    ...(FACT_FIELDS.some((f) => (f.key as string) === 'country') ? [{ key: 'country' as const, label: 'Country' }] : []),
  ];

  const appendNoteAttribution = (prev: string, attribution: string, sourceUrl?: string): string => {
    if ((sourceUrl && prev.includes(sourceUrl)) || (attribution && prev.includes(attribution))) {
      return prev;
    }
    return prev.trim() ? `${prev.trim()}; ${attribution}` : attribution;
  };

  const normalizedWeekends: EditionWeekend[] =
    weekendsMode === 'multi'
      ? weekends.map((w, i) => ({
          weekend: i + 1,
          startDate: w.startDate.trim(),
          ...(w.endDate?.trim() ? { endDate: w.endDate.trim() } : {}),
        }))
      : [];

  const fieldSuggestions: Suggestion[] = checkFields.flatMap(({ key: fieldKey, label }) => {
    if (!confirmed) return [];
    const v = confirmed[fieldKey as keyof DetailCandidate] as string | undefined;
    if (!v || !v.trim()) return [];
    const yours = (values[fieldKey] ?? '').trim();
    const same = fieldKey === 'country' ? sameCountry(v, yours) : v.trim() === yours;
    if (same) return [];
    const src = confirmed.sources.find((s) => s.fields.includes(fieldKey as any)) ?? confirmed.sources[0];
    const from = src ? (FIELD_SOURCE_LABELS[src.sourceType] ?? SOURCE_LABELS[src.sourceType] ?? src.sourceType) : 'a source';
    const sourceUrl = src?.sourceUrl || confirmed.sources.find((s) => s.sourceUrl)?.sourceUrl;
    const attribution = sourceUrl ? `${from} (${sourceUrl})` : from;
    return [{
      key: fieldKey,
      label,
      yours: yours || 'Not set',
      value: v,
      from,
      onUse: () => {
        setValues((prev) => ({ ...prev, [fieldKey]: v }));
        setNote((prev) => appendNoteAttribution(prev, attribution, sourceUrl));
      },
    }];
  });

  const weekendSuggestion: Suggestion[] = (() => {
    if (!confirmed?.weekends || confirmed.weekends.length < 2) return [];
    const sameWeekends =
      weekendsMode === 'multi' && serializeWeekends(normalizedWeekends) === serializeWeekends(confirmed.weekends);
    if (sameWeekends) return [];
    const src = confirmed.sources.find((s) => s.fields.includes('startDate')) ?? confirmed.sources[0];
    const from = src ? (FIELD_SOURCE_LABELS[src.sourceType] ?? SOURCE_LABELS[src.sourceType] ?? src.sourceType) : 'a source';
    const sourceUrl = src?.sourceUrl || confirmed.sources.find((s) => s.sourceUrl)?.sourceUrl;
    const attribution = sourceUrl ? `${from} (${sourceUrl})` : from;
    const yours =
      weekendsMode === 'multi' && normalizedWeekends.length > 0
        ? normalizedWeekends.map((w) => weekendLabel(w)).join(' · ')
        : values.startDate?.trim()
          ? (shortDateRange(values.startDate.trim(), values.endDate?.trim() || undefined) ?? values.startDate.trim())
          : 'Not set';
    const value = confirmed.weekends.map((w) => weekendLabel(w)).join(' · ');
    return [{
      key: 'weekends',
      label: 'Weekends',
      yours,
      value,
      from,
      onUse: () => {
        const nextWeekends = confirmed.weekends!.map((w) => ({
          weekend: w.weekend,
          startDate: w.startDate,
          ...(w.endDate ? { endDate: w.endDate } : {}),
        }));
        const starts = nextWeekends.map((w) => w.startDate).filter(Boolean).sort();
        const ends = nextWeekends.map((w) => w.endDate || w.startDate).filter(Boolean).sort();
        setWeekendsMode('multi');
        setWeekends(nextWeekends);
        setDraftBadges({});
        setValues((prev) => ({
          ...prev,
          ...(starts[0] ? { startDate: starts[0] } : {}),
          ...(ends[ends.length - 1] ? { endDate: ends[ends.length - 1] } : {}),
        }));
        setNote((prev) => appendNoteAttribution(prev, attribution, sourceUrl));
      },
    }];
  })();

  const suggestions: Suggestion[] = [...fieldSuggestions, ...weekendSuggestion];
  const weekendsMissingStart = weekendsMode === 'multi' && (normalizedWeekends.length === 0 || normalizedWeekends.some((w) => !w.startDate));
  const seriesChanged = seriesSlug !== (edition.seriesSlug ?? '');
  const weekendsChanged = serializeWeekends(normalizedWeekends) !== serializeWeekends(initialWeekends);

  const trimmed = (key: string) => (values[key] ?? '').trim();
  const fieldChanges = FACT_FIELDS.filter((f) => trimmed(f.key) !== stored(f.key).trim());
  const hasChanges = fieldChanges.length > 0 || seriesChanged || weekendsChanged;
  const nameBlank = trimmed('name') === '';
  const canSave = !saving && !nameBlank && !weekendsMissingStart && note.trim() !== '' && hasChanges;

  const createQuickSeries = async () => {
    const cleanName = newSeriesName.trim();
    if (!cleanName || creatingSeries) return;
    setCreatingSeries(true);
    setError(null);
    try {
      const created = await canonicalApi.createSeries({
        name: cleanName,
        ...(newSeriesBrand.trim() ? { brand: newSeriesBrand.trim() } : {}),
      });
      setSeriesList((prev) => [{ ...created, editionCount: 0 }, ...prev.filter((s) => s.slug !== created.slug)]);
      setSeriesSlug(created.slug);
      setNewSeriesName('');
      setNewSeriesBrand('');
      setNewSeriesOpen(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setCreatingSeries(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await canonicalApi.updateEdition(edition.id, {
        name: trimmed('name'),
        startDate: trimmed('startDate') || null,
        endDate: trimmed('endDate') || null,
        venue: trimmed('venue') || null,
        city: trimmed('city') || null,
        region: trimmed('region') || null,
        country: trimmed('country') || null,
        seriesSlug: seriesSlug || null,
        ...(weekendsChanged ? { weekends: normalizedWeekends } : {}),
        sourceNote: note.trim(),
      });
      onSaved(saved);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded-lg border border-zinc-800 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Edit facts</h4>
        <button
          type="button"
          onClick={() => void runResearch(false)}
          disabled={checking || geminiChecking}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-zinc-700 px-2.5 text-xs text-zinc-200 hover:border-violet-500 hover:text-violet-200 disabled:opacity-50 sm:min-h-8"
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          Check details
        </button>
      </div>
      <CheckDetails
        inline
        busy={checking}
        geminiBusy={geminiChecking}
        checkedAt={details?.checkedAt}
        status={details?.status ?? 'pending'}
        candidates={details?.candidates ?? []}
        notes={details?.notes ?? []}
        lineupStatus={lineupStatus}
        suggestions={suggestions}
        onCheck={() => void runResearch(false)}
        onGemini={() => void runResearch(true)}
        onPick={handlePick}
        onNone={handleNone}
      />
      {checkError && <p role="alert" className="text-xs text-rose-300">{checkError}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FACT_FIELDS.map((f) => {
          if (f.key === 'city') {
            return (
              <label key={f.key} className="space-y-1 text-xs text-zinc-400">
                <span className="block text-[11px] uppercase text-zinc-500">{f.label}</span>
                <SuggestInput
                  aria-label={f.label}
                  className={`${field} w-full`}
                  placeholder="Not known"
                  value={values.city ?? ''}
                  suggestions={citySuggestions}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, city: e.target.value }));
                    setCityQuery(e.target.value);
                  }}
                  onPick={(picked) => {
                    const patch = cityPickPatch(picked, seriesPastPlaces.places, values.country);
                    setValues((v) => ({
                      ...v,
                      city: patch.city ?? '',
                      region: patch.region ?? '',
                      ...(patch.country !== undefined ? { country: patch.country } : {}),
                    }));
                    setCityQuery(patch.city ?? '');
                  }}
                />
              </label>
            );
          }
          if (f.key === 'region') {
            return (
              <div key={f.key} className="space-y-1 text-xs text-zinc-400">
                <label className="block space-y-1">
                  <span className="block text-[11px] uppercase text-zinc-500">{f.label}</span>
                  <input
                    type="text"
                    aria-label={f.label}
                    className={`${field} w-full`}
                    placeholder="Not known"
                    value={values.region ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, region: e.target.value }))}
                  />
                </label>
                {mapOffer && (
                  <button
                    type="button"
                    onClick={() =>
                      setValues((v) => ({
                        ...v,
                        ...(mapOffer.patch.city ? { city: mapOffer.patch.city } : {}),
                        ...(mapOffer.patch.region ? { region: mapOffer.patch.region } : {}),
                        ...(mapOffer.patch.country ? { country: mapOffer.patch.country } : {}),
                      }))
                    }
                    className="block text-left text-xs text-violet-300 hover:underline"
                  >
                    Use “{mapOffer.value}” from {mapOffer.from}
                  </button>
                )}
                {effectiveSeriesKind !== 'tour' && editionPlaceEmpty && seriesPlaceLabel && (
                  <button
                    type="button"
                    onClick={() =>
                      setValues((v) => ({
                        ...v,
                        city: effectiveSeriesCity ?? '',
                        region: effectiveSeriesRegion ?? '',
                        country: effectiveSeriesCountry ?? '',
                      }))
                    }
                    className="block text-left text-xs text-violet-300 hover:underline"
                  >
                    Use “{seriesPlaceLabel}” from series
                  </button>
                )}
              </div>
            );
          }
          return (
            <label key={f.key} className="space-y-1 text-xs text-zinc-400">
              <span className="block text-[11px] uppercase text-zinc-500">{f.label}</span>
              <input
                type={f.type ?? 'text'}
                aria-label={f.label}
                className={`${field} w-full`}
                placeholder={f.type ? undefined : 'Not known'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </label>
          );
        })}
      </div>
      <div className="space-y-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] uppercase text-zinc-500">Series</span>
          <div className="flex items-center gap-2">
            {seriesSlug && (
              <button type="button" onClick={() => setSeriesSlug('')} className="text-xs text-zinc-400 hover:text-zinc-200">
                Detach
              </button>
            )}
            <button type="button" onClick={() => setNewSeriesOpen((o) => !o)} className="text-xs text-violet-300 hover:underline">
              {newSeriesOpen ? 'Close' : '+ New series'}
            </button>
          </div>
        </div>
        <select
          aria-label="Edition series"
          value={seriesSlug}
          onChange={(e) => setSeriesSlug(e.target.value)}
          className={`${field} w-full`}
        >
          <option value="">None (standalone)</option>
          {seriesSlug && !seriesList.some((s) => s.slug === seriesSlug) && (
            <option value={seriesSlug}>{edition.seriesName ?? seriesSlug}</option>
          )}
          {seriesList.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}{s.brand ? ` (${s.brand})` : ''}
            </option>
          ))}
        </select>
        {newSeriesOpen && (
          <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3">
            <input
              type="text"
              aria-label="New series name"
              placeholder="Series name"
              value={newSeriesName}
              onChange={(e) => setNewSeriesName(e.target.value)}
              className={field}
            />
            <SuggestInput
              type="text"
              aria-label="New series brand"
              placeholder="Brand (optional)"
              value={newSeriesBrand}
              suggestions={seriesBrands}
              onChange={(e) => setNewSeriesBrand(e.target.value)}
              onPick={(b) => setNewSeriesBrand(b)}
              className={`${field} w-full`}
            />
            <Button type="button" onClick={() => void createQuickSeries()} disabled={creatingSeries || !newSeriesName.trim()}>
              {creatingSeries ? 'Creating…' : 'Create & attach'}
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] uppercase text-zinc-500">Schedule</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setWeekendsMode('single')}
              className={`rounded-control border px-2 py-1 text-xs ${weekendsMode === 'single' ? 'border-violet-400 bg-violet-500/20 text-violet-100' : 'border-zinc-700 text-zinc-300'}`}
            >
              Single date range
            </button>
            <button
              type="button"
              onClick={() => {
                setWeekendsMode('multi');
                if (weekends.length === 0) {
                  const seeded = seedMultiWeekends({
                    name: values.name,
                    startDate: values.startDate,
                    endDate: values.endDate,
                    confirmedWeekends: confirmed?.weekends,
                  });
                  setWeekends(seeded.weekends);
                  setDraftBadges(seeded.draftBadges);
                }
              }}
              className={`rounded-control border px-2 py-1 text-xs ${weekendsMode === 'multi' ? 'border-violet-400 bg-violet-500/20 text-violet-100' : 'border-zinc-700 text-zinc-300'}`}
            >
              Multiple weekends
            </button>
          </div>
        </div>
        {weekendsMode === 'multi' && (
          <div className="space-y-2">
            {weekends.map((w, idx) => (
              <div key={idx} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[auto_1fr_1fr_auto]">
                <div className="flex flex-wrap items-center gap-1.5 sm:pb-2">
                  <span className="text-xs font-semibold text-zinc-300">Weekend {idx + 1}</span>
                  {draftBadges[w.weekend] && <Pill tone="warn">{draftBadges[w.weekend]}</Pill>}
                </div>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span className="block text-[10px] uppercase text-zinc-500">Start date</span>
                  <input
                    type="date"
                    aria-label={`Weekend ${idx + 1} start date`}
                    className={`${field} w-full`}
                    value={w.startDate}
                    onChange={(e) => {
                      setWeekends((prev) => prev.map((item, j) => (j === idx ? { ...item, startDate: e.target.value } : item)));
                      setDraftBadges((prev) => {
                        if (!(w.weekend in prev)) return prev;
                        const next = { ...prev };
                        delete next[w.weekend];
                        return next;
                      });
                    }}
                  />
                </label>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span className="block text-[10px] uppercase text-zinc-500">End date</span>
                  <input
                    type="date"
                    aria-label={`Weekend ${idx + 1} end date`}
                    className={`${field} w-full`}
                    value={w.endDate ?? ''}
                    onChange={(e) => {
                      setWeekends((prev) => prev.map((item, j) => (j === idx ? { ...item, endDate: e.target.value || undefined } : item)));
                      setDraftBadges((prev) => {
                        if (!(w.weekend in prev)) return prev;
                        const next = { ...prev };
                        delete next[w.weekend];
                        return next;
                      });
                    }}
                  />
                </label>
                {weekends.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const nextBadges: Record<number, string> = {};
                      weekends.forEach((item, j) => {
                        if (j === idx) return;
                        const newNum = j > idx ? j : j + 1;
                        if (draftBadges[item.weekend]) nextBadges[newNum] = draftBadges[item.weekend];
                      });
                      setDraftBadges(nextBadges);
                      setWeekends((prev) => prev.filter((_, j) => j !== idx).map((item, k) => ({ ...item, weekend: k + 1 })));
                    }}
                    className="text-xs text-rose-300 hover:underline sm:pb-2"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {weekends.length < 9 && (
              <button
                type="button"
                onClick={() => setWeekends((prev) => [...prev, { weekend: prev.length + 1, startDate: '' }])}
                className="text-xs text-violet-300 hover:underline"
              >
                + Add weekend
              </button>
            )}
            {weekendsMissingStart && <p className="text-xs text-rose-300">Every weekend needs a start date.</p>}
          </div>
        )}
      </div>
      {nameBlank && <p className="text-xs text-rose-300">An edition needs a name.</p>}
      <label className="block space-y-1 text-xs text-zinc-400">
        <span className="block text-[11px] uppercase text-zinc-500">Source note (required)</span>
        <textarea
          aria-label="Source note"
          rows={2}
          className={`${field} w-full`}
          placeholder="Where these facts came from, e.g. the festival's site, with a link if you have one"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="space-y-1 text-xs text-zinc-300">
        {!hasChanges ? (
          <p className="text-zinc-500">No fact has changed yet.</p>
        ) : (
          <>
            <p className="text-[11px] uppercase text-zinc-500">Changes to save</p>
            <ul className="space-y-0.5">
              {fieldChanges.map((f) => (
                <li key={f.key}>
                  {f.label}: <span className="text-zinc-500">{stored(f.key) || 'Not known'}</span> → <span className="text-zinc-100">{trimmed(f.key) || 'Not known (cleared)'}</span>
                </li>
              ))}
              {seriesChanged && (
                <li>
                  Series: <span className="text-zinc-500">{edition.seriesSlug || 'None'}</span> → <span className="text-zinc-100">{seriesSlug || 'None (detached)'}</span>
                </li>
              )}
              {weekendsChanged && (
                <li>
                  Weekends: <span className="text-zinc-500">{initialWeekends.length ? `${initialWeekends.length} weekend(s)` : 'Single date range'}</span> →{' '}
                  <span className="text-zinc-100">{normalizedWeekends.length ? `${normalizedWeekends.length} weekend(s)` : 'Single date range'}</span>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={!canSave}>{saving ? 'Saving…' : 'Save facts'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  );
};

const ActRecord: React.FC<{ act: EditionPerformance; partners: string[] }> = ({ act, partners }) => {
  const artistKey = (act as { canonicalArtistKey?: string }).canonicalArtistKey || act.artistKey || act.name;
  const artistLink = artistKey ? canonicalArtistUrl(artistKey) : null;
  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        {artistLink ? (
          <a
            href={artistLink}
            onClick={(e) => {
              if (isModifiedClick(e)) return;
              e.preventDefault();
              window.history.pushState({ fromManageList: true }, '', artistLink);
              rememberManageSearch(new URL(artistLink, window.location.origin).search);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
            className="font-medium text-zinc-100 hover:text-violet-300 hover:underline"
          >
            {act.name}
          </a>
        ) : (
          <span className="font-medium text-zinc-100">{act.name}</span>
        )}
        <Pill tone="neutral">{BILLING_WORDS[act.billing ?? ''] ?? 'Artist'}</Pill>
        {partners.length > 0 && <span className="text-xs text-zinc-400">B2B with {partners.join(', ')}</span>}
      </div>
    <p className="text-xs text-zinc-400">
      Set: {act.set ?? 'Not known'} · Day: {act.days.join(', ') || 'Not known'} · Stage: {act.stages.join(', ') || 'Not known'}
    </p>
    {act.sources.length === 0 && <p className="text-xs text-rose-300">No source stored for this act.</p>}
    {act.sources.map((s, i) => {
      const curated = s.extractor === 'admin_curation';
      return (
        <div key={i} className="space-y-1 border-l-2 border-zinc-800 pl-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {curated ? <Pill tone="accent">Admin curated</Pill> : <span className="text-zinc-300">{SOURCE_LABELS[s.sourceType] ?? s.sourceType}</span>}
            {s.sourceUrl ? (
              <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">Source link</a>
            ) : (
              <span className="text-zinc-500">No link</span>
            )}
          </div>
          {s.quotedSpan ? <blockquote className="text-zinc-300">“{s.quotedSpan}”</blockquote> : <p className="text-zinc-500">{curated ? 'Curated by you, no quote.' : 'No quote stored.'}</p>}
          {s.sets && s.sets.length > 0 ? (
            s.sets.map((t, j) => (
              <p key={j} className="text-zinc-300">
                Set time: {[t.day, t.stage, t.start && t.end ? `${t.start} to ${t.end}` : t.start ?? t.end].filter(Boolean).join(' · ') || 'Not known'}
              </p>
            ))
          ) : (
            <p className="text-zinc-500">Set times: not timed by this source.</p>
          )}
        </div>
      );
    })}
  </li>
  );
};
