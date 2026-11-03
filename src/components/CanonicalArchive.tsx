import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { canonicalApi, LookupJob } from '../services/lineupApi';
import type { CanonicalArtistSummary, CanonicalEditionSummary } from '../server/entities/canonicalManage';
import { LineupReview } from './LineupReview';

// Global Archive (owner only, spec Phase 4): ingest a lineup, browse editions and
// the artist catalog. Counts only; no member names. Never writes a personal log.

const ORIGIN_LABEL: Record<CanonicalArtistSummary['origins'][number], string> = {
  from_me: 'From me',
  unmanaged_fetch: 'Unmanaged fetch',
  community_import: 'Community import',
};

const field = 'rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none';

export const CanonicalArchive: React.FC = () => {
  const [artists, setArtists] = useState<CanonicalArtistSummary[] | null>(null);
  const [editions, setEditions] = useState<CanonicalEditionSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'confirmed' | 'draft'>('all');
  const [name, setName] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<LookupJob | null>(null);

  const loadEditions = useCallback(async () => {
    try {
      setEditions((await canonicalApi.editions(query, status)).editions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [query, status]);

  useEffect(() => {
    void loadEditions();
  }, [loadEditions]);

  useEffect(() => {
    canonicalApi
      .artists()
      .then((r) => setArtists(r.artists))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const ingest = async () => {
    setError(null);
    const y = Number(year);
    if (!name.trim()) return setError('Enter the event or festival name.');
    if (!Number.isInteger(y)) return setError('Enter a four-digit year.');
    setBusy(true);
    try {
      const started = await canonicalApi.ingest({ name: name.trim(), year: y, lineupUrl: url.trim() || undefined });
      setJob(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshAfterSave = () => {
    setJob(null);
    setName('');
    setUrl('');
    void loadEditions();
  };

  if (job) {
    if (job.status === 'needs_review') {
      return <LineupReview job={job} mode="canonical" onClose={() => setJob(null)} onSaved={refreshAfterSave} />;
    }
    return (
      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
        <p>The lookup for {job.input.eventName} {job.input.year} is {job.status.replace(/_/g, ' ')}. Come back when it is ready to review.</p>
        <button onClick={() => setJob(null)} className="text-violet-300 hover:text-violet-200">Back to the archive</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
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
        {error && <p className="text-sm text-rose-300">{error}</p>}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-sm font-semibold text-zinc-100">Editions</h3>
          <input aria-label="Search editions" className={`${field} w-56`} placeholder="Search name, series or venue" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select aria-label="Edition status" className={field} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All</option>
            <option value="confirmed">Confirmed</option>
            <option value="draft">Drafts (owner only)</option>
          </select>
        </div>
        {editions === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : editions.length === 0 ? (
          <p className="text-sm text-zinc-400">No editions yet. Ingest one above.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {editions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 p-2.5 text-sm">
                <span className="font-medium text-zinc-100">{e.name}</span>
                <span className="text-xs text-zinc-400">{[e.startDate, e.venue, e.city].filter(Boolean).join(' · ') || 'Details missing'}</span>
                <span className="ml-auto text-xs text-zinc-400">{e.performanceCount} billed · {e.status === 'confirmed' ? 'confirmed' : 'draft'}{e.hasSetTimes ? ' · set times' : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-zinc-100">Artists in the archive</h3>
        {artists === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : artists.length === 0 ? (
          <p className="text-sm text-zinc-400">No artists yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {artists.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
                <span className="text-zinc-100">{a.name}</span>
                {a.origins.map((o) => (
                  <span key={o} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300">{ORIGIN_LABEL[o]}</span>
                ))}
                <span className="ml-auto text-xs text-zinc-400">
                  {a.editionsCount} billed {a.editionsCount === 1 ? 'edition' : 'editions'}
                  {a.communityCount === null ? '' : ` · ${a.communityCount} community`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
