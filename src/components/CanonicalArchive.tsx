import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { canonicalApi, LookupJob } from '../services/lineupApi';
import type { Edition } from '../server/lineup/types';
import type { ArtistAppearance } from '../server/entities/canonicalManage';
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

export const CanonicalArchive: React.FC<{ artistQuery?: string }> = ({ artistQuery = '' }) => {
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
  const [detail, setDetail] = useState<{ kind: 'edition'; edition: Edition } | { kind: 'artist'; artist: CanonicalArtistSummary; appearances: ArtistAppearance[] } | null>(null);

  const openEdition = async (id: string) => {
    setError(null);
    try {
      setDetail({ kind: 'edition', edition: (await canonicalApi.edition(id)).edition });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openArtist = async (key: string) => {
    setError(null);
    try {
      const r = await canonicalApi.artist(key);
      setDetail({ kind: 'artist', artist: r.artist, appearances: r.appearances });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const q = artistQuery.trim().toLowerCase();
  const shownArtists = (artists ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.key.includes(q));

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

  if (detail) {
    return (
      <div className="space-y-4">
        <button onClick={() => setDetail(null)} className="text-sm text-violet-300 hover:text-violet-200">← Back to the archive</button>
        {detail.kind === 'edition' ? <EditionDetail edition={detail.edition} /> : <ArtistDetail artist={detail.artist} appearances={detail.appearances} />}
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

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-zinc-100">Artists in the archive</h3>
        {artists === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : artists.length === 0 ? (
          <p className="text-sm text-zinc-400">No artists yet.</p>
        ) : shownArtists.length === 0 ? (
          <p className="text-sm text-zinc-400">No artist matches "{artistQuery}".</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {shownArtists.map((a) => (
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
