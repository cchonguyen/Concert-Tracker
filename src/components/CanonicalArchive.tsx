import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { canonicalApi, entitiesApi, lineupApi, LookupJob, SOURCE_LABELS } from '../services/lineupApi';
import { reviewSubjectFromEdition } from '../services/reviewRows';
import type { HistoryEntry } from '../server/entities/types';
import type { Edition, EditionPerformance } from '../server/lineup/types';
import type { ArtistAppearance, CanonicalArtistRecord, CanonicalEditionSummary } from '../server/entities/canonicalManage';
import { CanonicalArtistEntry, ORIGIN_LABEL } from './CanonicalArtistEntry';
import { LineupReview } from './LineupReview';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';

// Global Archive (owner only, spec Phase 4). Each section is one body rendered by ManageView:
// Artists, Editions & Lineups, Lookups. Counts only; no member names. Never writes a personal log.
// The search box and the edition status filter live in ManageView and arrive as props.

export type ArchiveSection = 'artists' | 'editions' | 'lookups';
export type EditionStatus = 'all' | 'confirmed' | 'draft';

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
  if (section === 'editions') return <ArchiveEditions query={query} status={status} />;
  return <ArchiveArtists query={query} />;
};

const ArchiveArtists: React.FC<{ query: string }> = ({ query }) => {
  const [artists, setArtists] = useState<CanonicalArtistRecord[] | null>(null);
  const [detail, setDetail] = useState<{ artist: CanonicalArtistRecord; appearances: ArtistAppearance[] } | null>(null);
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

  const openArtist = async (key: string) => {
    setError(null);
    try {
      const r = await canonicalApi.artist(key);
      setDetail({ artist: r.artist, appearances: r.appearances });
    } catch (err) {
      setError(messageOf(err));
    }
  };

  // A saved change: show it with Undo, then the artist where it now is (the list after a merge).
  const changed = async (entry: HistoryEntry, key: string | null) => {
    setNotice({ text: `${entry.summary}.`, undo: entry.id });
    await loadList();
    if (key === null) setDetail(null);
    else await openArtist(key);
  };

  const undo = async (id: string) => {
    setBusy(true);
    try {
      const r = await entitiesApi.undo(id);
      setNotice({ text: `Undid: ${r.entry.summary}.` });
      setDetail(null);
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
          onBack={() => setDetail(null)}
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
          {shown.map((a) => (
            <li key={a.key}>
              <button onClick={() => void openArtist(a.key)} className="flex w-full flex-wrap items-center gap-2 p-2.5 text-left text-sm hover:bg-zinc-900/60">
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const ArchiveEditions: React.FC<{ query: string; status: EditionStatus }> = ({ query, status }) => {
  const [editions, setEditions] = useState<CanonicalEditionSummary[] | null>(null);
  const [detail, setDetail] = useState<Edition | null>(null);
  // Edit lineup: the review screen, seeded from the saved edition (canonical mode).
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEditions((await canonicalApi.editions(query, status)).editions);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [query, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdition = async (id: string) => {
    setError(null);
    try {
      setDetail((await canonicalApi.edition(id)).edition);
    } catch (err) {
      setError(messageOf(err));
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
        <button
          onClick={() => {
            setDetail(null);
            void load();
          }}
          className="text-sm text-violet-300 hover:text-violet-200"
        >
          ← Back to editions
        </button>
        <EditionDetail edition={detail} onEditLineup={() => setEditing(true)} />
      </div>
    );
  }

  return (
    <section className="space-y-2">
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {editions === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      ) : editions.length === 0 ? (
        <p className="text-sm text-zinc-400">{query || status !== 'all' ? 'No editions match.' : 'No editions yet. Ingest one under Lookups.'}</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {editions.map((e) => (
            <li key={e.id}>
              <button onClick={() => void openEdition(e.id)} className="flex w-full flex-wrap items-baseline gap-x-3 p-2.5 text-left text-sm hover:bg-zinc-900/60">
                <span className="font-medium text-zinc-100">{e.name}</span>
                <span className="text-xs text-zinc-400">{[e.startDate, e.venue, e.city].filter(Boolean).join(' · ') || 'Details missing'}</span>
                <span className="ml-auto text-xs text-zinc-400">{e.performanceCount} billed · {e.status === 'confirmed' ? 'confirmed' : 'draft'}{e.hasSetTimes ? ' · set times' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
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

const BILLING_WORDS: Record<string, string> = { headliner: 'Headliner', support: 'Support' };

// One edition as a record (owner only). Missing data reads "Not known"; nothing is filled in.
// Each act shows its billing role, B2B partners, set, day, stage and set times, and each source
// shows its quote, or the "Admin curated" badge for the owner's own curation.
const EditionDetail: React.FC<{ edition: Edition; onEditLineup: () => void }> = ({ edition, onEditLineup }) => {
  const names = new Map(edition.performances.map((p) => [p.artistKey, p.name]));
  const dates = [edition.startDate, edition.endDate && edition.endDate !== edition.startDate ? `to ${edition.endDate}` : null].filter(Boolean).join(' ');
  const facts: Array<[string, string | undefined]> = [
    ['Series', edition.seriesSlug],
    ['Year', String(edition.year)],
    ['Dates', dates || undefined],
    ['Venue', edition.venue],
    ['City', edition.city],
    ['Country', edition.country],
    ['Status', edition.status === 'confirmed' ? 'Confirmed' : 'Draft (owner only)'],
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-zinc-50">{edition.name}</h3>
          <p className="text-xs text-zinc-500">Catalog record. Your personal log is not changed.</p>
        </div>
        <Button onClick={onEditLineup}>Edit lineup</Button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] uppercase text-zinc-500">{label}</dt>
            <dd className={value ? 'text-zinc-100' : 'italic text-zinc-500'}>{value ?? 'Not known'}</dd>
          </div>
        ))}
      </dl>
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

const ActRecord: React.FC<{ act: EditionPerformance; partners: string[] }> = ({ act, partners }) => (
  <li className="space-y-2 p-3 text-sm">
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="font-medium text-zinc-100">{act.name}</span>
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
