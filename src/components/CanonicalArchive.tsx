import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { canonicalApi, lineupApi, LookupJob } from '../services/lineupApi';
import type { Edition } from '../server/lineup/types';
import type { ArtistAppearance } from '../server/entities/canonicalManage';
import type { CanonicalArtistSummary, CanonicalEditionSummary } from '../server/entities/canonicalManage';
import { LineupReview } from './LineupReview';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';

// Global Archive (owner only, spec Phase 4). Each section is one body rendered by ManageView:
// Artists, Editions & Lineups, Lookups. Counts only; no member names. Never writes a personal log.
// The search box and the edition status filter live in ManageView and arrive as props.

export type ArchiveSection = 'artists' | 'editions' | 'lookups';
export type EditionStatus = 'all' | 'confirmed' | 'draft';

const ORIGIN_LABEL: Record<CanonicalArtistSummary['origins'][number], string> = {
  from_me: 'From me',
  unmanaged_fetch: 'Unmanaged fetch',
  community_import: 'Community import',
};

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
  const [artists, setArtists] = useState<CanonicalArtistSummary[] | null>(null);
  const [detail, setDetail] = useState<{ artist: CanonicalArtistSummary; appearances: ArtistAppearance[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    canonicalApi
      .artists()
      .then((r) => setArtists(r.artists))
      .catch((err) => setError(messageOf(err)));
  }, []);

  const openArtist = async (key: string) => {
    setError(null);
    try {
      const r = await canonicalApi.artist(key);
      setDetail({ artist: r.artist, appearances: r.appearances });
    } catch (err) {
      setError(messageOf(err));
    }
  };

  if (detail) {
    return (
      <div className="space-y-4">
        <button onClick={() => setDetail(null)} className="text-sm text-violet-300 hover:text-violet-200">← Back to artists</button>
        <ArtistDetail artist={detail.artist} appearances={detail.appearances} />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = (artists ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.key.includes(q));

  return (
    <section className="space-y-2">
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
                  <span key={o} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300">{ORIGIN_LABEL[o]}</span>
                ))}
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

  if (detail) {
    return (
      <div className="space-y-4">
        <button onClick={() => setDetail(null)} className="text-sm text-violet-300 hover:text-violet-200">← Back to editions</button>
        <EditionDetail edition={detail} />
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

const EditionDetail: React.FC<{ edition: Edition }> = ({ edition }) => (
  <div className="space-y-3">
    <div>
      <h3 className="text-lg font-semibold text-zinc-50">{edition.name}</h3>
      <p className="text-sm text-zinc-400">
        {[edition.startDate, edition.endDate && edition.endDate !== edition.startDate ? `to ${edition.endDate}` : null, edition.venue, edition.city].filter(Boolean).join(' · ') || 'Dates and place not known'}
      </p>
      <p className="text-xs text-zinc-500">{edition.status === 'confirmed' ? 'Confirmed' : 'Draft (owner only)'}</p>
    </div>
    {edition.performances.length === 0 ? (
      <p className="text-sm text-zinc-400">No acts recorded for this edition.</p>
    ) : (
      <table className="w-full text-left text-sm">
        <thead className="text-[11px] uppercase text-zinc-400">
          <tr><th className="p-2">Act</th><th className="p-2">Billing</th><th className="p-2">Set</th><th className="p-2">Day / stage</th><th className="p-2">Source</th></tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {edition.performances.map((p) => (
            <tr key={p.artistKey}>
              <td className="p-2 text-zinc-100">{p.name}</td>
              <td className="p-2 text-zinc-300">{p.billing ?? 'Artist'}</td>
              <td className="p-2 text-zinc-300">{p.set ?? 'Not known'}</td>
              <td className="p-2 text-xs text-zinc-400">{[...p.days, ...p.stages].join(', ') || 'Not timed'}</td>
              <td className="p-2 text-xs text-zinc-400">
                {p.sources.map((s, i) => (s.sourceUrl ? <a key={i} href={s.sourceUrl} target="_blank" rel="noreferrer" className="block text-violet-300 hover:underline">{s.extractor === 'admin_curation' ? 'Owner curated' : s.sourceType}</a> : <span key={i} className="block">{s.extractor === 'admin_curation' ? 'Owner curated, no link' : s.sourceType}</span>))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

const ArtistDetail: React.FC<{ artist: CanonicalArtistSummary; appearances: ArtistAppearance[] }> = ({ artist, appearances }) => (
  <div className="space-y-3">
    <div>
      <h3 className="text-lg font-semibold text-zinc-50">{artist.name}</h3>
      <div className="mt-1 flex flex-wrap gap-2">
        {artist.origins.map((o) => (
          <span key={o} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300">{ORIGIN_LABEL[o]}</span>
        ))}
      </div>
      <p className="mt-1 text-xs text-zinc-500">{artist.mbid ? `MusicBrainz ${artist.mbid}` : 'No MusicBrainz id yet'}</p>
    </div>
    {appearances.length === 0 ? (
      <p className="text-sm text-zinc-400">Not in any edition in the archive yet.</p>
    ) : (
      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {appearances.map((a) => (
          <li key={`${a.editionId}-${a.billing ?? ''}-${a.set ?? ''}`} className="p-2.5 text-sm">
            <span className="text-zinc-100">{a.editionName}</span>
            <span className="ml-2 text-xs text-zinc-400">{[a.billing ?? 'Artist', a.set, a.startDate, a.venue].filter(Boolean).join(' · ')}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);
