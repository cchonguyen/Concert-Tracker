import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  canonicalApi,
  CanonicalChangeRow,
  entitiesApi,
  FIELD_SOURCE_LABELS,
  inboxApi,
  lineupApi,
  type LineupStatus,
  type LoggedEvent,
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
import { emptyPlaceFields, type VenueLocation } from '../server/canon/venueLocation';
import { CanonicalArtistEntry, ORIGIN_LABEL, type SavedChange } from './CanonicalArtistEntry';
import { CheckDetails, type Suggestion } from './CheckDetails';
import { LineupReview } from './LineupReview';
import { EditionNameGaps } from './EditionNameGaps';
import { VenueFillPanel } from './VenueFillPanel';
import { ArtistCleanupPanel } from './ArtistCleanupPanel';
import { MergeEditionModal } from './MergeEditionModal';
import { usePlaceAutofill } from './PlaceFields';
import { SuggestInput } from './SuggestInput';
import { shortDateRange, weatherLine, weekendLabel } from '../services/format';
import { buildPastPlaces, cityPickPatch, formatPlaceLabel, unanimousPlace } from '../services/placeAutofill';
import { seedMultiWeekends } from '../services/weekends';
import { seriesDisplayName } from '../services/series';
import { Button } from './ui/Button';
import { Callout } from './ui/Callout';
import { Equalizer } from './ui/Equalizer';
import { HintPill, type HintTone } from './ui/HintPill';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';
import { Pill } from './ui/Pill';
import { Segmented } from './ui/Segmented';
import { VersionPicker } from './ui/VersionPicker';
import { PasteSetTimes } from './PasteSetTimes';
import { GenresPanel } from './GenresPanel';
import {
  buildManageUrl,
  canonicalArtistUrl,
  editionUrl,
  isModifiedClick,
  parseManageParams,
  rememberManageSearch,
  seriesUrl,
} from '../services/manageNav';
import { useKeptScroll } from './useKeptScroll';

// Global Archive (owner only, spec Phase 4). Each section is one body rendered by ManageView:
// Artists, Series, Brands, Genres, Editions & Lineups, Lookups, Changes. Counts only; no member names. Never writes a personal log.
// The search box and the edition status filter live in ManageView and arrive as props.

export type ArchiveSection = 'artists' | 'series' | 'brands' | 'genres' | 'editions' | 'lookups' | 'changes';
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
const STATUS_HINT: Record<LookupJob['status'], HintTone> = {
  queued: 'busy',
  running: 'busy',
  waiting_quota: 'needs',
  needs_review: 'needs',
  no_data: 'info',
  confirmed: 'done',
  failed: 'needs',
};
const isActive = (j: LookupJob) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting_quota';
// Retry runs the job again now (POST /api/lookups/:id/run).
const canRetry = (j: LookupJob) => j.status === 'waiting_quota' || j.status === 'no_data' || j.status === 'failed';
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const field = 'min-h-11 sm:min-h-9 rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';

export const CanonicalArchive: React.FC<{ section: ArchiveSection; query: string; status: EditionStatus; events: LoggedEvent[] }> = ({
  section,
  query,
  status,
  events,
}) => {
  if (section === 'lookups') return <ArchiveLookups />;
  if (section === 'changes') return <ArchiveChanges />;
  if (section === 'series') return <ArchiveSeries query={query} />;
  if (section === 'brands') return <ArchiveBrands query={query} />;
  if (section === 'genres') return <GenresPanel query={query} events={events} />;
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
    <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
      {notice.text}
      {notice.undo && (
        <button onClick={() => void undo(notice.undo!)} disabled={busy} className="min-h-11 rounded-control px-1.5 text-accent hover:underline disabled:opacity-40 sm:min-h-9">
          Undo
        </button>
      )}
    </p>
  );

  useKeptScroll('archive:artists', !detail, artists !== null);

  const q = query.trim().toLowerCase();
  const shown = (artists ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.key.includes(q) || a.akas.some((k) => k.includes(q)));

  return (
    <section className="space-y-2">
      <ArtistCleanupPanel onApplied={() => void loadList()} />
      {noticeLine}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {detail && !shown.some((a) => a.key === detail.artist.key) && (
        <CanonicalArtistEntry
          artist={detail.artist}
          appearances={detail.appearances}
          artists={artists ?? []}
          onBack={handleBackToArtists}
          onChanged={(entry, key) => void changed(entry, key)}
        />
      )}
      {artists === null ? (
        <span role="status" aria-label="Loading artists" className="inline-flex items-center text-text-muted">
          <Equalizer />
        </span>
      ) : artists.length === 0 ? (
        <p className="text-sm text-text-muted">No artists yet.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-text-muted">No artist matches "{query}".</p>
      ) : (
        <Ledger>
          {shown.map((a) => {
            const url = canonicalArtistUrl(a.key, { q: query || undefined });
            const isOpen = detail?.artist.key === a.key;
            return (
              <React.Fragment key={a.key}>
                <Ledger.Row edge="none" selected={isOpen} className="row-hover hover:border-l-4">
                  <a
                    href={url}
                    onClick={(e) => {
                      if (isModifiedClick(e)) return;
                      e.preventDefault();
                      if (isOpen) {
                        handleBackToArtists();
                        return;
                      }
                      window.history.pushState({ fromManageList: true }, '', url);
                      rememberManageSearch(new URL(url, window.location.origin).search);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                    className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="font-medium text-text">{a.name}</span>
                    {a.origins.map((o) => (
                      <Pill key={o} tone="neutral">{ORIGIN_LABEL[o]}</Pill>
                    ))}
                    <span className="text-[11px] text-text-faint">{a.mbid ? 'MusicBrainz' : 'No MusicBrainz id'}</span>
                    {a.akas.length > 0 && <span className="basis-full text-xs text-text-faint">Also known as {a.akas.join(', ')}</span>}
                    <span className="ml-auto font-mono text-xs tabular-nums text-text-muted">
                      {a.editionsCount} billed {a.editionsCount === 1 ? 'edition' : 'editions'}
                      {a.communityCount === null ? '' : ` · ${a.communityCount} community`}
                    </span>
                  </a>
                </Ledger.Row>
                {isOpen && detail && (
                  <div className="border-b border-line bg-surface-0 p-3">
                    <CanonicalArtistEntry
                      artist={detail.artist}
                      appearances={detail.appearances}
                      artists={artists ?? []}
                      onBack={handleBackToArtists}
                      onChanged={(entry, key) => void changed(entry, key)}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </Ledger>
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

// Brands (Global Editions): one table of brands with rename, merge into another brand,
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
      {brands === null && !error && (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <Equalizer />
          <span>Loading brands…</span>
        </p>
      )}
      {brands && brands.length === 0 && <p className="text-sm text-text-muted">No brands yet. A brand appears once a series has one.</p>}
      {visible.length > 0 && (
        <Ledger>
          {visible.map((b) => (
            <Ledger.Row key={b.id} edge="none" className="flex-col items-stretch gap-2 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-text">{b.name}</span>
                <span className="text-xs text-text-muted">{b.organizationId ? orgName.get(b.organizationId) ?? 'Organization' : 'No organization'}</span>
              </div>
              {b.aliases.length > 0 && <p className="text-xs text-text-faint">Also known as {b.aliases.join(', ')}</p>}
              <p className="font-mono text-xs tabular-nums text-text-muted">
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
            </Ledger.Row>
          ))}
        </Ledger>
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

  useKeptScroll('archive:series', !detailSlug, seriesList !== null);

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
          className="inline-flex min-h-11 items-center text-sm text-accent hover:underline sm:min-h-9"
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
        <form onSubmit={(e) => void createNewSeries(e)} className="space-y-3 rounded-card border border-line bg-surface-1 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-normal text-text">Create series</h3>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase text-text-muted">Type</span>
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
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Name *</span>
              <input
                required
                className={`${field} w-full`}
                placeholder="e.g. EDC Las Vegas"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Brand (optional)</span>
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
                <label className="space-y-1 text-xs text-text-muted">
                  <span className="block text-[11px] uppercase text-text-muted">City (optional)</span>
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
                <div className="space-y-1 text-xs text-text-muted">
                  <label className="block space-y-1">
                    <span className="block text-[11px] uppercase text-text-muted">State (optional)</span>
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
                      className="block text-left text-xs text-accent hover:underline"
                    >
                      Use “{mapOffer.value}” from {mapOffer.from}
                    </button>
                  )}
                </div>
                <label className="space-y-1 text-xs text-text-muted">
                  <span className="block text-[11px] uppercase text-text-muted">Country (optional)</span>
                  <input
                    className={`${field} w-full`}
                    placeholder="e.g. United States"
                    value={newCountry}
                    onChange={(e) => setNewCountry(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <p className="text-xs text-text-muted sm:col-span-2">
                Tour series are location-agnostic; each stop carries its own venue and city.
              </p>
            )}
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Aliases (comma-separated)</span>
              <input
                className={`${field} w-full`}
                placeholder="e.g. EDC, EDCLV"
                value={newAliases}
                onChange={(e) => setNewAliases(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Lineup URL (optional)</span>
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
              {savingNew && <Equalizer size="sm" />} Create series
            </Button>
          </div>
        </form>
      )}

      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}

      {seriesList === null ? (
        <span role="status" aria-label="Loading series" className="inline-flex items-center text-text-muted">
          <Equalizer />
        </span>
      ) : seriesList.length === 0 ? (
        <p className="text-sm text-text-muted">{query || brandFilter ? 'No series match.' : 'No series yet.'}</p>
      ) : (
        <Ledger>
          {seriesList.map((s) => {
            const url = seriesUrl(s.slug, { q: query || undefined });
            const place = s.kind !== 'tour' ? formatPlaceLabel(s) : '';
            return (
              <Ledger.Row key={s.slug} edge={s.kind === 'festival' ? 'festival' : s.kind === 'tour' ? 'show' : 'none'} className="row-hover hover:border-l-4">
                <a
                  href={url}
                  onClick={(e) => {
                    if (isModifiedClick(e)) return;
                    e.preventDefault();
                    openSeries(s.slug);
                  }}
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="font-medium text-text">{s.name}</span>
                  <Pill tone="neutral">{s.kind === 'tour' ? 'Tour' : s.kind === 'festival' ? 'Festival' : 'Not set'}</Pill>
                  {s.brand && <Pill tone="accent">{s.brand}</Pill>}
                  {place && <span className="text-xs text-text-muted">{place}</span>}
                  {s.aliases && s.aliases.length > 0 && (
                    <span className="text-xs text-text-faint">AKA {s.aliases.join(', ')}</span>
                  )}
                  <span className="ml-auto font-mono text-xs tabular-nums text-text-muted">
                    {s.editionCount} {s.editionCount === 1 ? 'edition' : 'editions'}
                  </span>
                </a>
              </Ledger.Row>
            );
          })}
        </Ledger>
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
  // null = Not set: a series with no type yet is saved without one, never as festival (series type fix).
  const [kind, setKind] = useState<SeriesKind | null>(null);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [qualifier, setQualifier] = useState('');
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
    enabled: editing && kind !== 'tour',
  });

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await canonicalApi.seriesEditions(slug);
      setSeries(res.series);
      setEditions(res.editions);
      setKind(res.series.kind === 'tour' || res.series.kind === 'festival' ? res.series.kind : null);
      setName(res.series.name);
      setBrand(res.series.brand ?? '');
      setQualifier(res.series.qualifier ?? '');
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

  // With a brand and a place or tour name, the name is built from them and not typed (series cleanup).
  const builtName =
    brand.trim() && qualifier.trim() ? seriesDisplayName({ name, brand, qualifier, kind: kind ?? undefined }) : null;

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(builtName ?? name).trim() || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await canonicalApi.updateSeries(slug, {
        name: (builtName ?? name).trim(),
        ...(kind ? { kind } : {}),
        brand: brand.trim() || null,
        qualifier: qualifier.trim() || null,
        ...(kind !== 'tour'
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

  if (loading && !series) {
    return (
      <span role="status" aria-label="Loading series" className="inline-flex items-center text-text-muted">
        <Equalizer />
      </span>
    );
  }
  if (!series) return <p role="alert" className="text-sm text-bad">{error ?? 'Series not found.'}</p>;

  const mergeTargets = allSeries.filter((s) => s.slug !== slug);
  const seriesPlaceLabel = series.kind !== 'tour' ? formatPlaceLabel(series) : '';
  const seriesPlaceEmpty = !city.trim() && !region.trim() && !country.trim();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-xl font-normal text-text">{series.name}</h3>
            <Pill tone="neutral">{series.kind === 'tour' ? 'Tour' : series.kind === 'festival' ? 'Festival' : 'Not set'}</Pill>
            {series.brand && <Pill tone="accent">{series.brand}</Pill>}
            {seriesPlaceLabel && <span className="text-xs text-text-muted">{seriesPlaceLabel}</span>}
          </div>
          <p className="font-mono text-xs text-text-faint">Slug: {series.slug}</p>
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
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}

      {merging && (
        <div className="space-y-2 rounded-card border border-warn/45 bg-warn/10 p-3 text-sm">
          <p className="font-semibold text-text">Merge "{series.name}" into another series</p>
          <p className="text-xs text-text-muted">
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
              {mergeBusy && <Equalizer size="sm" />} Merge series
            </Button>
          </div>
        </div>
      )}

      {editing ? (
        <form onSubmit={(e) => void saveEdit(e)} className="space-y-3 rounded-card border border-line bg-surface-1 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase text-text-muted">Type</span>
            <Segmented
              label="Series type"
              value={kind ?? ''}
              onChange={(v) => setKind(v as SeriesKind)}
              options={[
                { value: 'festival', label: 'Festival' },
                { value: 'tour', label: 'Tour' },
              ]}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Name</span>
              <input
                required
                readOnly={builtName !== null}
                title={builtName !== null ? 'Built from the brand and the place or tour name.' : undefined}
                className={`${field} w-full`}
                value={builtName ?? name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Brand</span>
              <SuggestInput
                className={`${field} w-full`}
                placeholder="Optional"
                value={brand}
                suggestions={seriesBrands}
                onChange={(e) => setBrand(e.target.value)}
                onPick={(b) => setBrand(b)}
              />
            </label>
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">{kind === 'tour' ? 'Tour name' : 'Place'}</span>
              <input
                className={`${field} w-full`}
                placeholder={kind === 'tour' ? 'Optional, e.g. Duality Tour' : 'Optional, e.g. SoCal'}
                value={qualifier}
                onChange={(e) => setQualifier(e.target.value)}
                maxLength={120}
              />
            </label>
            {kind !== 'tour' ? (
              <>
                <label className="space-y-1 text-xs text-text-muted">
                  <span className="block text-[11px] uppercase text-text-muted">City</span>
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
                <div className="space-y-1 text-xs text-text-muted">
                  <label className="block space-y-1">
                    <span className="block text-[11px] uppercase text-text-muted">State</span>
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
                      className="block text-left text-xs text-accent hover:underline"
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
                      className="block text-left text-xs text-accent hover:underline"
                    >
                      Use “{editionsPlace.label}” from attached editions
                    </button>
                  )}
                </div>
                <label className="space-y-1 text-xs text-text-muted">
                  <span className="block text-[11px] uppercase text-text-muted">Country</span>
                  <input
                    className={`${field} w-full`}
                    placeholder="Optional"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <p className="text-xs text-text-muted sm:col-span-2">
                Tour series are location-agnostic; each stop carries its own venue and city.
              </p>
            )}
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Aliases (comma-separated)</span>
              <input className={`${field} w-full`} placeholder="e.g. EDC, EDCLV" value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block text-[11px] uppercase text-text-muted">Lineup URL</span>
              <input className={`${field} w-full`} placeholder="https://…" value={lineupUrl} onChange={(e) => setLineupUrl(e.target.value)} />
            </label>
          </div>
          <div className="space-y-1">
            <span className="block text-[11px] uppercase text-text-muted">Source priority</span>
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_PRIORITY_OPTIONS.map((src) => {
                const active = sourcePriority.includes(src);
                return (
                  <button
                    key={src}
                    type="button"
                    aria-pressed={active}
                    onClick={() => togglePriority(src)}
                    className={`min-h-11 rounded-full border px-2.5 py-0.5 text-xs sm:min-h-9 ${
                      active
                        ? 'border-accent-tint-line bg-accent-tint text-accent'
                        : 'border-line-strong text-text-muted hover:border-accent'
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
            <dt className="text-[11px] uppercase text-text-muted">Aliases</dt>
            <dd className={series.aliases?.length ? 'text-text' : 'italic text-text-faint'}>
              {series.aliases?.length ? series.aliases.join(', ') : 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase text-text-muted">Lineup URL</dt>
            <dd className="truncate">
              {series.lineupUrl ? (
                <a href={series.lineupUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {series.lineupUrl}
                </a>
              ) : (
                <span className="italic text-text-faint">Not set</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase text-text-muted">Place</dt>
            <dd className={seriesPlaceLabel ? 'text-text' : 'italic text-text-faint'}>
              {series.kind === 'tour' ? 'Location-agnostic (tour)' : seriesPlaceLabel || 'Not set'}
            </dd>
          </div>
          {series.sourcePriority && series.sourcePriority.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-[11px] uppercase text-text-muted">Source priority</dt>
              <dd className="text-text">
                {series.sourcePriority.map((s) => SOURCE_LABELS[s] ?? s).join(' → ')}
              </dd>
            </div>
          )}
        </dl>
      )}

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-text">
          Editions (<span className="font-mono tabular-nums">{editions.length}</span>)
        </h4>
        {editions.length === 0 ? (
          <p className="text-sm text-text-muted">No editions attached to this series yet.</p>
        ) : (
          <Ledger>
            {editions.map((e) => {
              const url = editionUrl(e.id);
              const dateText = e.weekends.length > 1
                ? e.weekends.map((w) => weekendLabel(w, 'WK')).join(' · ')
                : e.startDate ?? String(e.year);
              return (
                <Ledger.Row key={e.id} edge="none" className="row-hover hover:border-l-4">
                  <a
                    href={url}
                    onClick={(ev) => {
                      if (isModifiedClick(ev)) return;
                      ev.preventDefault();
                      window.history.pushState({ fromManageList: true }, '', url);
                      rememberManageSearch(new URL(url, window.location.origin).search);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                    className="flex w-full flex-wrap items-baseline gap-x-3 px-3 py-2.5 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="font-medium text-text">{e.name}</span>
                    <span className="font-mono text-xs tabular-nums text-text-muted">
                      {[dateText, e.venue, e.city].filter(Boolean).join(' · ')}
                    </span>
                    <span className="ml-auto font-mono text-xs tabular-nums text-text-muted">
                      {e.performanceCount} billed · {editionStatusWords(e.status).split(' (')[0].toLowerCase()}
                    </span>
                  </a>
                </Ledger.Row>
              );
            })}
          </Ledger>
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

  useKeptScroll('archive:editions', !detail, page !== null);

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
          className="text-sm text-accent hover:underline"
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
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <EditionNameGaps />
      <VenueFillPanel />
      {page === null ? (
        <Equalizer />
      ) : page.editions.length === 0 ? (
        <p className="text-sm text-text-muted">{query || status !== 'all' ? 'No editions match.' : 'No editions yet. Find a lineup under Lineup lookups to add one.'}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-xs tabular-nums text-text-muted" role="status">
              {page.hasMore ? `Showing ${page.editions.length} of ${page.total}` : `${page.total} ${page.total === 1 ? 'edition' : 'editions'}`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {selectMode && (
                <>
                  <span className="font-mono text-xs tabular-nums text-text-muted">{selectedIds.size} selected</span>
                  <Button
                    variant="primary"
                    disabled={selectedIds.size < 2 || loadingMerge}
                    onClick={() => void startSelectedMerge()}
                  >
                    {loadingMerge && <Equalizer size="sm" />} Merge selected…
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
          <Ledger>
            {page.editions.map((e) => {
              const url = editionUrl(e.id, { status, q: query || undefined });
              const checked = selectedIds.has(e.id);
              const dateSummary = e.weekends.length > 1
                ? `${e.weekends.length} weekends`
                : e.startDate;
              const placeSummary = [e.venue, e.city].filter(Boolean).join(' · ');
              return (
                <Ledger.Row key={e.id} className="flex items-center p-0">
                  {selectMode && (
                    <label className="flex cursor-pointer items-center pl-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelect(e.id)}
                        aria-label={`Select ${e.name}`}
                        className="h-4 w-4 accent-[var(--accent)]"
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
                    className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 px-3 py-2.5 text-left text-sm row-hover"
                  >
                    <span className="font-medium text-text">{e.name}</span>
                    {e.seriesName && (
                      <span className="text-xs text-accent">
                        {e.seriesName}{e.seriesBrand ? ` · ${e.seriesBrand}` : ''}
                      </span>
                    )}
                    {(dateSummary || placeSummary) ? (
                      <span className="text-xs text-text-muted">
                        {dateSummary && <span className="font-mono tabular-nums">{dateSummary}</span>}
                        {dateSummary && placeSummary && ' · '}
                        {placeSummary}
                      </span>
                    ) : (
                      <span className="text-xs text-text-muted">Details missing</span>
                    )}
                    <span className="ml-auto font-mono text-xs tabular-nums text-text-muted">{e.performanceCount} billed · {editionStatusWords(e.status).split(' (')[0].toLowerCase()}{e.hasSetTimes ? ' · set times' : ''}</span>
                  </a>
                </Ledger.Row>
              );
            })}
          </Ledger>
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

  const stop = async (id: string) => {
    setError(null);
    setRetrying(id);
    try {
      const latest = await lineupApi.stop(id);
      setLookups((prev) => (prev ?? []).map((j) => (j.id === id ? latest : j)));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRetrying(null);
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
      <div className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
        <h3 className="font-display text-base font-normal text-text">Find a lineup for the catalog</h3>
        <p className="text-xs text-text-muted">Finds the lineup for an event you did not attend. Nothing is added to your log.</p>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Event or festival name" className={`${field} min-w-[12rem] flex-1`} placeholder="Event or festival name" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Year" className={`${field} w-24 font-mono tabular-nums`} inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          <input aria-label="Lineup URL (optional)" className={`${field} min-w-[12rem] flex-1`} placeholder="Lineup URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
          {name.trim() && /^\d{4}$/.test(year) && (
            <VersionPicker
              key={`${name.trim()}-${year}`}
              load={async () => canonicalApi.versions(name.trim(), Number(year))}
              onPick={(v) => setUrl(v.url)}
            />
          )}
          <Button variant="primary" onClick={ingest} disabled={busy}>
            {busy && <Equalizer size="sm" />} Find lineup
          </Button>
        </div>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </div>

      <section className="space-y-2" aria-labelledby="lookups-heading">
        <h3 id="lookups-heading" className="font-display text-base font-normal text-text">Lineup lookups</h3>
        {lookups === null ? (
          <Equalizer />
        ) : lookups.length === 0 ? (
          <p className="text-sm text-text-muted">No lineup lookups yet. A new one shows here as soon as it starts.</p>
        ) : (
          <Ledger>
            {lookups.map((j) => (
              <Ledger.Row key={j.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-text">{j.input.eventName}</span>
                <span className="font-mono text-xs tabular-nums text-text-muted">{j.input.year}</span>
                <HintPill tone={STATUS_HINT[j.status]}>{STATUS_WORDS[j.status]}</HintPill>
                {j.status === 'failed' && j.lastError && <span className="basis-full text-xs text-bad">{j.lastError}</span>}
                {j.status === 'waiting_quota' && j.waitingReason && <span className="basis-full text-xs text-warn">{j.waitingReason}</span>}
                <span className="ml-auto flex gap-2">
                  {j.status === 'needs_review' && <Button variant="primary" onClick={() => setReviewing(j)}>Review</Button>}
                  {(j.status === 'queued' || j.status === 'waiting_quota') && (
                    <Button variant="ghost" onClick={() => void stop(j.id)} disabled={retrying === j.id}>
                      Stop
                    </Button>
                  )}
                  {canRetry(j) && (
                    <Button onClick={() => void retry(j.id)} disabled={retrying === j.id}>
                      {retrying === j.id && <Equalizer size="sm" />} Retry
                    </Button>
                  )}
                </span>
              </Ledger.Row>
            ))}
          </Ledger>
        )}
      </section>
    </div>
  );
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// The Changes list (owner only): canonical changes, newest first, 50 a page through Load more.
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
        error ? null : <Equalizer />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">No changes yet.</p>
      ) : (
        <Ledger>
          {rows.map((r) => (
            <Ledger.Row key={r.id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={r.undoneAt ? 'text-text-faint line-through' : 'text-text'}>{r.summary}</span>
                <span className="font-mono text-[11px] tabular-nums text-text-muted">{when(r.time)}</span>
                {r.undoneAt ? (
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">Undone {when(r.undoneAt)}</span>
                ) : (
                  <span className="ml-auto">
                    <Button onClick={() => void undo(r)} disabled={busyId !== null}>
                      {busyId === r.id && <Equalizer size="sm" />} Undo
                    </Button>
                  </span>
                )}
              </div>
              <p className={`text-xs ${r.undoneAt ? 'text-text-faint line-through' : 'text-text-muted'}`}>
                {r.before} → {r.after}
              </p>
            </Ledger.Row>
          ))}
        </Ledger>
      )}
      {list?.hasMore && (
        <div>
          <Button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Equalizer size="sm" />} Load more
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
  // Clashfinder "Find lineup": festival editions with no lineup only. The job goes to Lookups for review.
  const [findingLineup, setFindingLineup] = useState(false);
  const [lineupNote, setLineupNote] = useState<{ editionId: string; text: string } | null>(null);
  const canFindLineup = edition.seriesKind === 'festival' && edition.performances.length === 0;
  const [lineupLink, setLineupLink] = useState('');
  const findLineup = async () => {
    setFindingLineup(true);
    try {
      const res = await fetch(`/api/manage/canonical/editions/${encodeURIComponent(edition.id)}/find-lineup`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lineupLink.trim() ? { lineupUrl: lineupLink.trim() } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`);
      setLineupNote({ editionId: edition.id, text: 'Lineup lookup started. Review the result under Lookups.' });
    } catch (e) {
      setLineupNote({ editionId: edition.id, text: `Could not start the lookup. ${verifyError(e)}` });
    } finally {
      setFindingLineup(false);
    }
  };
  // Paste set times (docs/specs/pasted-set-times.md): read in code, the link is never visited. Reviewed under Lookups.
  const [pasting, setPasting] = useState(false);
  const pasteSets = async (url: string, text: string) => {
    setPasting(true);
    try {
      const res = await fetch(`/api/manage/canonical/editions/${encodeURIComponent(edition.id)}/paste-sets`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`);
      setLineupNote({ editionId: edition.id, text: 'Pasted set times sent. Review them under Lookups.' });
    } catch (e) {
      setLineupNote({ editionId: edition.id, text: `Could not read the pasted set times. ${verifyError(e)}` });
    } finally {
      setPasting(false);
    }
  };
  const lineupStatus = lineupNote?.editionId === edition.id ? lineupNote : null;
  const note = verifyNote?.editionId === edition.id ? verifyNote : null;
  // Owner refresh of the edition's weather. A change is in the edition history, so Undo is there.
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherStatus, setWeatherStatus] = useState<{ editionId: string; text: string } | null>(null);
  const refreshWeather = async () => {
    setWeatherBusy(true);
    try {
      const r = await canonicalApi.refreshWeather(edition.id);
      if (r.changed && r.weather) onFactsSaved({ ...edition, weather: r.weather });
      setWeatherStatus({
        editionId: edition.id,
        text: r.changed ? 'Weather refreshed. The change is in the edition history.' : r.note ?? 'The archive has no new reading. The stored record is kept.',
      });
    } catch (e) {
      setWeatherStatus({ editionId: edition.id, text: `Could not refresh the weather. ${verifyError(e)}` });
    } finally {
      setWeatherBusy(false);
    }
  };
  const weatherNote = weatherStatus?.editionId === edition.id ? weatherStatus : null;
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
          <h3 className="font-display text-xl font-normal text-text">{edition.name}</h3>
          <p className="text-xs text-text-muted">Catalog record. Your personal log is not changed.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {edition.status === 'provisional' && (
            <Button variant="primary" onClick={() => void verifyEdition()} disabled={verifying}>
              {verifying && <Equalizer size="sm" />} Verify for everyone
            </Button>
          )}
          {!editingFacts && <Button onClick={() => setEditingFacts(true)}>Edit facts</Button>}
          {canFindLineup && (
            <Button onClick={() => void findLineup()} disabled={findingLineup}>
              {findingLineup && <Equalizer size="sm" />} Find lineup
            </Button>
          )}
          <Button onClick={onEditLineup}>Edit lineup</Button>
          {edition.weather && (
            <Button onClick={() => void refreshWeather()} disabled={weatherBusy}>
              {weatherBusy && <Equalizer size="sm" />} Refresh weather
            </Button>
          )}
          {onStartMerge && <Button onClick={onStartMerge}>Merge with…</Button>}
        </div>
      </div>
      {canFindLineup && (
        <input
          className={`${field} w-full`}
          value={lineupLink}
          onChange={(e) => setLineupLink(e.target.value)}
          placeholder="Lineup page for Find lineup, if you know one (optional)"
          aria-label="Lineup page"
        />
      )}
      {edition.startDate && (
        <PasteSetTimes startDate={edition.startDate} endDate={edition.endDate} busy={pasting} onSubmit={(url, text) => void pasteSets(url, text)} />
      )}
      {lineupStatus && <p className="text-sm text-text-muted" role="status">{lineupStatus.text}</p>}
      {edition.weather && (
        <div className="space-y-1 text-xs text-text-muted">
          <p className="text-text">Weather, {edition.weather.place}. Read from the Open-Meteo archive.</p>
          <ul className="space-y-0.5">
            {edition.weather.days.map((d) => (
              <li key={d.date}>
                <span className="font-mono tabular-nums">{d.date}</span>: {weatherLine(d) || 'No reading'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {weatherNote && <p className="text-sm text-text-muted" role="status">{weatherNote.text}</p>}
      {(edition.status === 'provisional' || note) && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {edition.status === 'provisional' && <span className="text-xs text-text-muted">Members entered this. Verifying makes it autofill for everyone.</span>}
          {note && (
            <>
              <span className="text-text-muted" role="status">{note.text}</span>
              {note.changeId && (
                <button onClick={() => void undoVerify(note.changeId!)} disabled={verifying} className="text-accent hover:underline disabled:opacity-40">
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
              <dt className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Series</dt>
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
                        className="text-accent hover:underline"
                      >
                        {edition.seriesName ?? edition.seriesSlug}
                      </a>
                    ) : (
                      <span className="text-text">{edition.seriesName ?? edition.seriesSlug}</span>
                    )}
                    {edition.seriesBrand && <Pill tone="accent">{edition.seriesBrand}</Pill>}
                  </>
                ) : (
                  <span className="italic text-text-muted">None</span>
                )}
              </dd>
            </div>
            {facts.map((item) => (
              <div key={item.label}>
                <dt className="font-mono text-[11px] uppercase tracking-wider text-text-muted">{item.label}</dt>
                <dd className={`${item.value ? 'text-text' : 'italic text-text-muted'}${item.value && (item.label === 'Year' || item.label === 'Dates') ? ' font-mono tabular-nums' : ''}`}>
                  {item.value ?? 'Not known'}
                  {item.fromSeries && <span className="ml-1 text-xs text-text-muted">(from series)</span>}
                </dd>
              </div>
            ))}
          </dl>
          {edition.weekends && edition.weekends.length > 0 && (
            <div className="space-y-1">
              <p className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Weekends</p>
              <div className="flex flex-wrap gap-1.5">
                {edition.weekends.map((w) => (
                  <Pill key={w.weekend} tone="neutral">
                    {weekendLabel(w)}
                  </Pill>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-text-muted">
            Facts source: {edition.factSourceNote ? <span className="text-text">{edition.factSourceNote}</span> : <span className="italic text-text-muted">No source note for these facts yet.</span>}
          </p>
        </>
      )}
      {edition.performances.length === 0 ? (
        <p className="text-sm text-text-muted">No acts recorded for this edition.</p>
      ) : (
        <>
          {(() => {
            const candidates = edition.performances.filter((p) => p.verification === 'candidate').length;
            return candidates > 0 ? (
              <p className="text-xs text-warn">
                {candidates} {candidates === 1 ? 'act' : 'acts'} not yet verified. Each shows as a candidate until a second source agrees or the owner verifies it.
              </p>
            ) : null;
          })()}
        <Ledger>
          {edition.performances.map((p) => (
            <ActRecord key={p.artistKey} act={p} partners={(p.b2b ?? []).map((k) => names.get(k) ?? k)} />
          ))}
        </Ledger>
        </>
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

  // A venue with one known location fills the empty City, Region and Country (blanks only); several are offered.
  // Each venue text is looked up once, so a field you cleared is not filled again for the same venue.
  const [venueFilled, setVenueFilled] = useState<string[]>([]);
  const [venueChoices, setVenueChoices] = useState<VenueLocation[]>([]);
  const venueLooked = useRef<string>((edition.venue ?? '').trim().toLowerCase());
  const venueText = values.venue ?? '';
  useEffect(() => {
    const name = venueText.trim();
    const key = name.toLowerCase();
    if (!name || key === venueLooked.current) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      venueLooked.current = key;
      setVenueChoices([]);
      setVenueFilled([]);
      canonicalApi.venueLocation(name, ctrl.signal).then(
        (r) => {
          if (r.kind === 'several') setVenueChoices(r.choices);
          if (r.kind !== 'one') return;
          setValues((v) => {
            const patch = emptyPlaceFields({ city: v.city, region: v.region, country: v.country }, r.location);
            setVenueFilled(Object.keys(patch));
            return { ...v, ...patch };
          });
        },
        () => undefined,
      );
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [venueText]);

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
      className="space-y-3 rounded-card border border-line bg-surface-1 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Edit facts</h4>
        <button
          type="button"
          onClick={() => void runResearch(false)}
          disabled={checking || geminiChecking}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-line-strong px-2.5 text-xs text-text hover:border-accent hover:text-accent disabled:opacity-50 sm:min-h-9"
        >
          {checking ? <Equalizer size="sm" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
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
      {checkError && <p role="alert" className="text-xs text-bad">{checkError}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FACT_FIELDS.map((f) => {
          if (f.key === 'city') {
            return (
              <label key={f.key} className="space-y-1 text-xs text-text-muted">
                <span className="block font-mono text-[11px] uppercase tracking-wider text-text-muted">{f.label}</span>
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
              <div key={f.key} className="space-y-1 text-xs text-text-muted">
                <label className="block space-y-1">
                  <span className="block font-mono text-[11px] uppercase tracking-wider text-text-muted">{f.label}</span>
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
                    className="block text-left text-xs text-accent hover:underline"
                  >
                    Use “{mapOffer.value}” from {mapOffer.from}
                  </button>
                )}
                {venueFilled.length > 0 && (
                  <p className="text-xs text-text-muted">Filled from venue records: {venueFilled.map((k) => (k === 'region' ? 'region' : k)).join(', ')}.</p>
                )}
                {venueChoices.map((c) => (
                  <button
                    key={formatPlaceLabel(c)}
                    type="button"
                    onClick={() => {
                      setValues((v) => ({ ...v, ...emptyPlaceFields({ city: v.city, region: v.region, country: v.country }, c) }));
                      setVenueChoices([]);
                    }}
                    className="block text-left text-xs text-accent hover:underline"
                  >
                    Use “{formatPlaceLabel(c)}” from venue records
                  </button>
                ))}
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
                    className="block text-left text-xs text-accent hover:underline"
                  >
                    Use “{seriesPlaceLabel}” from series
                  </button>
                )}
              </div>
            );
          }
          return (
            <label key={f.key} className="space-y-1 text-xs text-text-muted">
              <span className="block font-mono text-[11px] uppercase tracking-wider text-text-muted">{f.label}</span>
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
      <div className="space-y-2 rounded-card border border-line bg-surface-2/40 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Series</span>
          <div className="flex items-center gap-2">
            {seriesSlug && (
              <button type="button" onClick={() => setSeriesSlug('')} className="text-xs text-text-muted hover:text-text">
                Detach
              </button>
            )}
            <button type="button" onClick={() => setNewSeriesOpen((o) => !o)} className="text-xs text-accent hover:underline">
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
      <div className="space-y-2 rounded-card border border-line bg-surface-2/40 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Schedule</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setWeekendsMode('single')}
              className={`min-h-11 sm:min-h-9 rounded-control border px-2.5 py-1 text-xs ${weekendsMode === 'single' ? 'border-accent bg-accent-tint text-accent' : 'border-line-strong text-text-muted hover:text-text'}`}
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
              className={`min-h-11 sm:min-h-9 rounded-control border px-2.5 py-1 text-xs ${weekendsMode === 'multi' ? 'border-accent bg-accent-tint text-accent' : 'border-line-strong text-text-muted hover:text-text'}`}
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
                  <span className="font-mono text-xs font-semibold tabular-nums text-text">Weekend {idx + 1}</span>
                  {draftBadges[w.weekend] && <Pill tone="warn">{draftBadges[w.weekend]}</Pill>}
                </div>
                <label className="space-y-1 text-xs text-text-muted">
                  <span className="block font-mono text-[10px] uppercase tracking-wider text-text-muted">Start date</span>
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
                <label className="space-y-1 text-xs text-text-muted">
                  <span className="block font-mono text-[10px] uppercase tracking-wider text-text-muted">End date</span>
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
                    className="text-xs text-bad hover:underline sm:pb-2"
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
                className="text-xs text-accent hover:underline"
              >
                + Add weekend
              </button>
            )}
            {weekendsMissingStart && <p className="text-xs text-bad">Every weekend needs a start date.</p>}
          </div>
        )}
      </div>
      {nameBlank && <p className="text-xs text-bad">An edition needs a name.</p>}
      <label className="block space-y-1 text-xs text-text-muted">
        <span className="block font-mono text-[11px] uppercase tracking-wider text-text-muted">Source note (required)</span>
        <textarea
          aria-label="Source note"
          rows={2}
          className={`${field} w-full`}
          placeholder="Where these facts came from, e.g. the festival's site, with a link if you have one"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="space-y-1 text-xs text-text-muted">
        {!hasChanges ? (
          <p className="text-text-faint">No fact has changed yet.</p>
        ) : (
          <>
            <p className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Changes to save</p>
            <ul className="space-y-0.5">
              {fieldChanges.map((f) => (
                <li key={f.key}>
                  {f.label}: <span className="text-text-faint">{stored(f.key) || 'Not known'}</span> → <span className="text-text">{trimmed(f.key) || 'Not known (cleared)'}</span>
                </li>
              ))}
              {seriesChanged && (
                <li>
                  Series: <span className="text-text-faint">{edition.seriesSlug || 'None'}</span> → <span className="text-text">{seriesSlug || 'None (detached)'}</span>
                </li>
              )}
              {weekendsChanged && (
                <li>
                  Weekends: <span className="text-text-faint">{initialWeekends.length ? `${initialWeekends.length} weekend(s)` : 'Single date range'}</span> →{' '}
                  <span className="text-text">{normalizedWeekends.length ? `${normalizedWeekends.length} weekend(s)` : 'Single date range'}</span>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
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
    <Ledger.Row className="space-y-2 text-sm">
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
            className="font-medium text-text hover:text-accent hover:underline"
          >
            {act.name}
          </a>
        ) : (
          <span className="font-medium text-text">{act.name}</span>
        )}
        <Pill tone="neutral">{BILLING_WORDS[act.billing ?? ''] ?? 'Artist'}</Pill>
        {act.verification === 'candidate' && <Pill tone="warn">Candidate</Pill>}
        {partners.length > 0 && <span className="text-xs text-text-muted">B2B with {partners.join(', ')}</span>}
      </div>
    <p className="text-xs text-text-muted">
      Set: {act.set ?? 'Not known'} · Day: {act.days.join(', ') || 'Not known'} · Stage: {act.stages.join(', ') || 'Not known'}
    </p>
    {act.sources.length === 0 && <p className="text-xs text-bad">No source stored for this act.</p>}
    {act.sources.map((s, i) => {
      const curated = s.extractor === 'admin_curation';
      return (
        <div key={i} className="space-y-1 border-l-2 border-line pl-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {curated ? <Pill tone="accent">Admin curated</Pill> : <span className="text-text">{SOURCE_LABELS[s.sourceType] ?? s.sourceType}</span>}
            {s.sourceUrl ? (
              <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Source link</a>
            ) : (
              <span className="text-text-muted">No link</span>
            )}
          </div>
          {s.quotedSpan ? <blockquote className="font-display italic text-text">“{s.quotedSpan}”</blockquote> : <p className="text-text-muted">{curated ? 'Curated by you, no quote.' : 'No quote stored.'}</p>}
          {s.sets && s.sets.length > 0 ? (
            s.sets.map((t, j) => (
              <p key={j} className="font-mono tabular-nums text-text-muted">
                Set time: {[t.day, t.stage, t.start && t.end ? `${t.start} to ${t.end}` : t.start ?? t.end].filter(Boolean).join(' · ') || 'Not known'}
              </p>
            ))
          ) : (
            <p className="text-text-muted">Set times: not timed by this source.</p>
          )}
        </div>
      );
    })}
  </Ledger.Row>
  );
};
