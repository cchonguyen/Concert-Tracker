import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import type { Edition, EditionPerformance } from '../server/lineup/types';
import type { DetailCandidate, EventDetails } from '../server/events/types';
import type { ArtistAppearance, CanonicalArtistRecord, CanonicalEditionSummary } from '../server/entities/canonicalManage';
import { sameCountry } from '../server/events/regions';
import { CanonicalArtistEntry, ORIGIN_LABEL, type SavedChange } from './CanonicalArtistEntry';
import { CheckDetails, type Suggestion } from './CheckDetails';
import { LineupReview } from './LineupReview';
import { Button } from './ui/Button';
import { Callout } from './ui/Callout';
import { Notice } from './ui/Notice';
import { Pill } from './ui/Pill';
import { VersionPicker } from './ui/VersionPicker';
import {
  buildManageUrl,
  canonicalArtistUrl,
  editionUrl,
  isModifiedClick,
  parseManageParams,
  rememberManageSearch,
} from '../services/manageNav';

// Global Archive (owner only, spec Phase 4). Each section is one body rendered by ManageView:
// Artists, Editions & Lineups, Lookups, Changes. Counts only; no member names. Never writes a personal log.
// The search box and the edition status filter live in ManageView and arrive as props.

export type ArchiveSection = 'artists' | 'editions' | 'lookups' | 'changes';
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

const ArchiveEditions: React.FC<{ query: string; status: EditionStatus }> = ({ query, status }) => {
  // The page is the first 200 matches of the filter (searched across the whole catalog); `total` counts every match.
  const [page, setPage] = useState<{ editions: CanonicalEditionSummary[]; total: number; hasMore: boolean } | null>(null);
  const [detail, setDetail] = useState<Edition | null>(null);
  const detailRef = useRef<Edition | null>(null);
  detailRef.current = detail;
  // Edit lineup: the review screen, seeded from the saved edition (canonical mode).
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(await canonicalApi.editions(query, status));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [query, status]);

  useEffect(() => {
    void load();
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
        <EditionDetail edition={detail} onEditLineup={() => setEditing(true)} onFactsSaved={setDetail} />
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
          <p className="text-xs text-zinc-400" role="status">
            {page.hasMore ? `Showing ${page.editions.length} of ${page.total}` : `${page.total} ${page.total === 1 ? 'edition' : 'editions'}`}
          </p>
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {page.editions.map((e) => {
              const url = editionUrl(e.id, { status, q: query || undefined });
              return (
                <li key={e.id}>
                  <a
                    href={url}
                    onClick={(eNav) => {
                      if (isModifiedClick(eNav)) return;
                      eNav.preventDefault();
                      window.history.pushState({ fromManageList: true }, '', url);
                      rememberManageSearch(new URL(url, window.location.origin).search);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                    className="flex w-full flex-wrap items-baseline gap-x-3 p-2.5 text-left text-sm hover:bg-zinc-900/60"
                  >
                    <span className="font-medium text-zinc-100">{e.name}</span>
                    <span className="text-xs text-zinc-400">{[e.startDate, e.venue, e.city].filter(Boolean).join(' · ') || 'Details missing'}</span>
                    <span className="ml-auto text-xs text-zinc-400">{e.performanceCount} billed · {editionStatusWords(e.status).split(' (')[0].toLowerCase()}{e.hasSetTimes ? ' · set times' : ''}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
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
const EditionDetail: React.FC<{ edition: Edition; onEditLineup: () => void; onFactsSaved: (edition: Edition) => void }> = ({ edition, onEditLineup, onFactsSaved }) => {
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
  const note = verifyNote?.editionId === edition.id ? verifyNote : null;
  const names = new Map(edition.performances.map((p) => [p.artistKey, p.name]));
  const dates = [edition.startDate, edition.endDate && edition.endDate !== edition.startDate ? `to ${edition.endDate}` : null].filter(Boolean).join(' ');
  const facts: Array<[string, string | undefined]> = [
    ['Series', edition.seriesSlug],
    ['Year', String(edition.year)],
    ['Dates', dates || undefined],
    ['Venue', edition.venue],
    ['City', edition.city],
    ['Country', edition.country],
    ['Status', editionStatusWords(edition.status)],
  ];
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
          <Button onClick={onEditLineup}>Edit lineup</Button>
        </div>
      </div>
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
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] uppercase text-zinc-500">{label}</dt>
                <dd className={value ? 'text-zinc-100' : 'italic text-zinc-500'}>{value ?? 'Not known'}</dd>
              </div>
            ))}
          </dl>
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
const FACT_FIELDS: Array<{ key: 'name' | 'startDate' | 'endDate' | 'venue' | 'city'; label: string; type?: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'startDate', label: 'Start date', type: 'date' },
  { key: 'endDate', label: 'End date', type: 'date' },
  { key: 'venue', label: 'Venue' },
  { key: 'city', label: 'City' },
];

const EditionFactsForm: React.FC<{ edition: Edition; onCancel: () => void; onSaved: (edition: Edition) => void }> = ({ edition, onCancel, onSaved }) => {
  const stored = (key: (typeof FACT_FIELDS)[number]['key']): string => (edition[key] ?? '') as string;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(FACT_FIELDS.map((f) => [f.key, stored(f.key)])));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lineupStatus, setLineupStatus] = useState<LineupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [geminiChecking, setGeminiChecking] = useState(false);
  const [details, setDetails] = useState<EventDetails | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

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

  const suggestions: Suggestion[] = checkFields.flatMap(({ key: fieldKey, label }) => {
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
        setNote((prev) => {
          if ((sourceUrl && prev.includes(sourceUrl)) || (attribution && prev.includes(attribution))) {
            return prev;
          }
          return prev.trim() ? `${prev.trim()}; ${attribution}` : attribution;
        });
      },
    }];
  });

  const trimmed = (key: string) => (values[key] ?? '').trim();
  const changes = FACT_FIELDS.filter((f) => trimmed(f.key) !== stored(f.key).trim());
  const nameBlank = trimmed('name') === '';
  const canSave = !saving && !nameBlank && note.trim() !== '' && changes.length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await canonicalApi.editFacts(edition.id, {
        name: trimmed('name'),
        startDate: trimmed('startDate') || null,
        endDate: trimmed('endDate') || null,
        venue: trimmed('venue') || null,
        city: trimmed('city') || null,
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
        {FACT_FIELDS.map((f) => (
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
        ))}
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
        {changes.length === 0 ? (
          <p className="text-zinc-500">No fact has changed yet.</p>
        ) : (
          <>
            <p className="text-[11px] uppercase text-zinc-500">Changes to save</p>
            <ul className="space-y-0.5">
              {changes.map((f) => (
                <li key={f.key}>
                  {f.label}: <span className="text-zinc-500">{stored(f.key) || 'Not known'}</span> → <span className="text-zinc-100">{trimmed(f.key) || 'Not known (cleared)'}</span>
                </li>
              ))}
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
