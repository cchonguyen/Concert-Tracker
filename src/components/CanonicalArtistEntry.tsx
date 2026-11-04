import React, { useState } from 'react';
import { GitMerge, Loader2, Plus, X } from 'lucide-react';
import { canonicalApi } from '../services/lineupApi';
import type { HistoryEntry } from '../server/entities/types';
import type { ArtistAppearance, CanonicalArtistRecord } from '../server/entities/canonicalManage';
import { normalizeName } from '../server/lineup/text';
import { IconButton } from './ui/IconButton';
import { Pill } from './ui/Pill';

// One catalog artist as a record (Global archive, GA3). Same layout as ManageEntry:
// name, AKAs, MusicBrainz id, origins, editions billed, community count, appearances.
// Missing data says so. Member events are never changed: only the shared catalog.

export const ORIGIN_LABEL: Record<CanonicalArtistRecord['origins'][number], string> = {
  from_me: 'From me',
  unmanaged_fetch: 'Unmanaged fetch',
  community_import: 'Community import',
};

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const primary =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40';
const quiet =
  'inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-400';

interface Problem {
  message: string;
  with?: { id: string; name: string };
}

export interface CanonicalArtistEntryProps {
  artist: CanonicalArtistRecord;
  appearances: ArtistAppearance[];
  // Every catalog artist, to pick a merge target from.
  artists: CanonicalArtistRecord[];
  onBack: () => void;
  // A change was saved. `key` is where the artist is now; null when it was merged away.
  onChanged: (entry: HistoryEntry, key: string | null) => void;
}

export const CanonicalArtistEntry: React.FC<CanonicalArtistEntryProps> = ({ artist, appearances, artists, onBack, onChanged }) => {
  const [name, setName] = useState(artist.name);
  const [aka, setAka] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [merging, setMerging] = useState(false);
  const [pick, setPick] = useState('');
  const [target, setTarget] = useState<CanonicalArtistRecord | null>(null);

  // Runs one change. True when it was saved (the parent then shows its Undo).
  const run = async (what: string, fn: () => Promise<HistoryEntry>, next: (entry: HistoryEntry) => string | null): Promise<boolean> => {
    setBusy(what);
    setProblem(null);
    try {
      const entry = await fn();
      onChanged(entry, next(entry));
      return true;
    } catch (err) {
      const conflict = (err as { conflict?: { id: string; name: string } }).conflict;
      setProblem({ message: err instanceof Error ? err.message : String(err), with: conflict });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const trimmed = name.trim();
  const renamed = trimmed !== '' && trimmed !== artist.name;
  const akaSpelling = normalizeName(aka);
  const candidates = artists
    .filter((a) => a.key !== artist.key)
    .filter((a) => {
      const q = pick.trim().toLowerCase();
      return !q || a.name.toLowerCase().includes(q) || a.key.includes(normalizeName(pick));
    })
    .slice(0, 8);

  const mbidNote = (() => {
    if (!target) return '';
    if (target.mbid) return `Keeps “${target.name}”’s MusicBrainz id.`;
    if (artist.mbid) return `“${target.name}” has no MusicBrainz id, so it takes “${artist.name}”’s.`;
    return 'Neither has a MusicBrainz id yet.';
  })();

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm text-violet-300 hover:text-violet-200">← Back to artists</button>

      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-zinc-50">{artist.name}</h3>
        <div className="flex flex-wrap gap-1.5">
          {artist.origins.map((o) => (
            <Pill key={o} tone="neutral">{ORIGIN_LABEL[o]}</Pill>
          ))}
        </div>
        <p className="text-xs text-zinc-400">
          {artist.mbid ? `MusicBrainz ${artist.mbid}` : 'No MusicBrainz id yet'} · {artist.editionsCount} billed{' '}
          {artist.editionsCount === 1 ? 'edition' : 'editions'} ·{' '}
          {artist.communityCount === null ? 'Community count not available' : `${artist.communityCount} community`}
        </p>
      </div>

      {problem && (
        <div role="alert" className="space-y-2 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          <p>{problem.message}</p>
          {problem.with && (
            <button onClick={() => { setMerging(true); setTarget(artists.find((a) => a.key === problem.with!.id) ?? null); }} className={quiet}>
              <GitMerge className="h-3.5 w-3.5" /> Merge into “{problem.with.name}”
            </button>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <h3 className={sectionTitle}>Name</h3>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (renamed) void run('rename', () => canonicalApi.renameArtist(artist.key, trimmed), () => normalizeName(trimmed));
          }}
        >
          <input className={control} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <button type="submit" disabled={!renamed || Boolean(busy)} className={primary}>
            {busy === 'rename' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Rename
          </button>
        </form>
        {renamed && (
          <p className="text-xs text-zinc-400">
            Changes the shared catalog only; member events keep the names they typed. “{artist.name}” is kept as an AKA.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <h3 className={sectionTitle}>Also known as</h3>
        {artist.akas.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {artist.akas.map((a) => (
              <li key={a} className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                {a}
                <IconButton
                  icon={X}
                  label={`Remove AKA ${a}`}
                  size="chip"
                  disabled={Boolean(busy)}
                  onClick={() => void run(`aka:${a}`, () => canonicalApi.removeArtistAka(artist.key, a), () => artist.key)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">No AKAs yet.</p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (aka.trim()) void run('aka', () => canonicalApi.addArtistAka(artist.key, aka.trim()), () => artist.key).then((ok) => ok && setAka(''));
          }}
        >
          <input className={control} value={aka} onChange={(e) => setAka(e.target.value)} placeholder="Another name or spelling" aria-label="Add an AKA" />
          <button type="submit" disabled={!akaSpelling || Boolean(busy)} className={quiet}>
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </form>
        <p className="text-xs text-zinc-400">Lineups that name this artist by an AKA are matched to it.</p>
      </div>

      <div className="space-y-1.5">
        <h3 className={sectionTitle}>Merge</h3>
        {!merging ? (
          <button onClick={() => setMerging(true)} className={quiet} disabled={artists.length < 2}>
            <GitMerge className="h-3.5 w-3.5" /> Merge into another artist
          </button>
        ) : (
          <div className="space-y-2">
            <input className={control} value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Find the artist to keep" aria-label="Find the artist to keep" />
            <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {candidates.map((a) => (
                <li key={a.key}>
                  <button
                    onClick={() => setTarget(a)}
                    className={`flex w-full items-center gap-2 p-2 text-left text-sm hover:bg-zinc-900/60 ${target?.key === a.key ? 'text-violet-200' : 'text-zinc-200'}`}
                  >
                    {a.name}
                    <span className="ml-auto text-xs text-zinc-500">{a.mbid ? 'MusicBrainz' : 'No MusicBrainz id'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {target && (
              <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-zinc-300">
                <p>
                  “{artist.name}” merges into “{target.name}”, and “{artist.name}” becomes an AKA. Its editions and performances move to “{target.name}”.
                  Your own record of this artist follows too, when you have one. Member events are not changed. {mbidNote} You can undo it.
                </p>
                <div className="flex gap-2">
                  <button onClick={() => void run('merge', () => canonicalApi.mergeArtist(artist.key, target.key), () => null)} disabled={Boolean(busy)} className={primary}>
                    {busy === 'merge' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />} Merge
                  </button>
                  <button onClick={() => { setMerging(false); setTarget(null); setPick(''); }} className={quiet}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className={sectionTitle}>Appearances</h3>
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
    </div>
  );
};
