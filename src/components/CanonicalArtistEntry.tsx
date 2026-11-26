import React, { useState } from 'react';
import { GitMerge, Plus, X } from 'lucide-react';
import {
  applyCanonicalArtistChange,
  canonicalApi,
  previewCanonicalArtistChange,
  type CanonicalArtistOperation,
  type CanonicalArtistPreview,
} from '../services/lineupApi';
import type { SaveTrack } from '../services/saveStatus';
import type { ArtistAppearance, ArtistChangeImpact, CanonicalArtistRecord } from '../server/entities/canonicalManage';
import { normalizeName } from '../server/lineup/text';
import { buildManageUrl, editionUrl, isModifiedClick, rememberManageSearch } from '../services/manageNav';
import { Button } from './ui/Button';
import { Callout } from './ui/Callout';
import { Equalizer } from './ui/Equalizer';
import { IconButton } from './ui/IconButton';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';
import { Pill } from './ui/Pill';
import { SaveStatus } from './ui/SaveStatus';

// One catalog artist as a record (Global archive, GA3). Same layout as ManageEntry:
// name, AKAs, MusicBrainz id, origins, editions billed, community count, appearances.
// Missing data says so. Member events are never changed: only the shared catalog.
// Rename, AKA add/remove and merge are two presses: "Preview" asks the server what the change
// would do (writes nothing), then "Apply" saves exactly that previewed change.

export const ORIGIN_LABEL: Record<CanonicalArtistRecord['origins'][number], string> = {
  from_me: 'From me',
  unmanaged_fetch: 'Unmanaged fetch',
  community_import: 'Community import',
};

const control =
  'min-h-11 sm:min-h-9 w-full rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';
const primary =
  'inline-flex min-h-11 sm:min-h-9 shrink-0 items-center gap-1.5 rounded-control bg-accent-fill px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40';
const quiet =
  'inline-flex min-h-11 sm:min-h-9 shrink-0 items-center gap-1 rounded-control border border-line-strong px-2.5 py-1.5 text-sm text-text-muted hover:text-text disabled:opacity-40';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
// The server's 409 when the fingerprint no longer matches the current state (the apply route).
const isStale = (err: unknown) => messageOf(err).includes('Preview is out of date');

type Section = 'name' | 'aka' | 'merge';

// A previewed change waiting for its second press. Nothing is written until Apply.
interface Pending {
  section: Section;
  op: CanonicalArtistOperation;
  // The change in words, old to new.
  label: string;
  // Where the artist is after apply; null when it was merged away.
  next: string | null;
  preview: CanonicalArtistPreview;
  // Rejected as stale: the only action is to preview again.
  stale: boolean;
}

interface Problem {
  message: string;
  with?: { id: string; name: string };
}

// What a saved change reports back: its history id (for Undo) and its one-line summary.
export interface SavedChange {
  id: string;
  summary: string;
}

export interface CanonicalArtistEntryProps {
  artist: CanonicalArtistRecord;
  appearances: ArtistAppearance[];
  // Every catalog artist, to pick a merge target from.
  artists: CanonicalArtistRecord[];
  onBack: () => void;
  // A change was saved. `key` is where the artist is now; null when it was merged away.
  onChanged: (entry: SavedChange, key: string | null) => void;
}

const ImpactCounts: React.FC<{ impact: ArtistChangeImpact }> = ({ impact }) => (
  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
    <div>
      <dt className="text-text-muted">Editions changed</dt>
      <dd className="font-mono tabular-nums text-text">{impact.editionsAffected}</dd>
    </div>
    <div>
      <dt className="text-text-muted">Performances moved</dt>
      <dd className="font-mono tabular-nums text-text">{impact.performancesMoved}</dd>
    </div>
    <div>
      <dt className="text-text-muted">Your records changed</dt>
      <dd className="font-mono tabular-nums text-text">{impact.ownerRecordsAffected}</dd>
    </div>
    <div>
      <dt className="text-text-muted">Community names changed</dt>
      <dd className="font-mono tabular-nums text-text">{impact.communityNameKeysAffected ?? 'Not available'}</dd>
    </div>
  </dl>
);

export const CanonicalArtistEntry: React.FC<CanonicalArtistEntryProps> = ({ artist, appearances, artists, onBack, onChanged }) => {
  const [name, setName] = useState(artist.name);
  const [aka, setAka] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [applyFailed, setApplyFailed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [pick, setPick] = useState('');
  const [target, setTarget] = useState<CanonicalArtistRecord | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  // Editing a section's input drops its preview, so Apply can never save an intent the screen no longer shows.
  const clearPending = (section: Section) => setPending((p) => (p && p.section === section ? null : p));

  // First press: ask the server what the change would do. Writes nothing.
  const preview = async (section: Section, op: CanonicalArtistOperation, label: string, next: string | null) => {
    setBusy('preview');
    setProblem(null);
    setApplyFailed(false);
    try {
      const result = await previewCanonicalArtistChange(artist.key, op);
      setPending({ section, op, label, next, preview: result, stale: false });
    } catch (err) {
      const conflict = (err as { conflict?: { id: string; name: string } }).conflict;
      setProblem({ message: messageOf(err), with: conflict });
    } finally {
      setBusy(null);
    }
  };

  // Second press: apply exactly the previewed operation, with the fingerprint of that preview.
  const apply = async () => {
    if (!pending || pending.stale) return;
    const current = pending;
    setBusy('apply');
    setProblem(null);
    setApplyFailed(false);
    try {
      const applied = await applyCanonicalArtistChange(artist.key, current.op, current.preview.previewFingerprint);
      setPending(null);
      if (current.op.op === 'alias-add') setAka('');
      onChanged({ id: applied.entry.id, summary: applied.entry.summary }, current.next);
    } catch (err) {
      if (isStale(err)) {
        setPending({ ...current, stale: true });
      } else {
        setApplyFailed(true);
        setProblem({ message: messageOf(err) });
      }
    } finally {
      setBusy(null);
    }
  };

  const refresh = () => {
    if (pending) void preview(pending.section, pending.op, pending.label, pending.next);
  };

  const cancel = () => {
    setPending(null);
    setApplyFailed(false);
  };

  const applyTrack: SaveTrack<'apply'> = { inFlight: busy === 'apply' ? 1 : 0, failed: applyFailed ? ['apply'] : [], savedAt: null };

  // The preview for one section, shown directly above its apply action.
  const pendingPanel = (section: Section) =>
    pending && pending.section === section ? (
      <div className="space-y-2 rounded-card border border-line bg-surface-1 p-3 text-sm">
        <p className="text-text">{pending.label}</p>
        {pending.stale ? (
          <Notice tone="warning">This preview is out of date, so nothing was saved. Preview again to see the current impact.</Notice>
        ) : (
          <div className="space-y-1">
            <p className="text-[11px] uppercase text-text-muted">Impact</p>
            <ImpactCounts impact={pending.preview.impact} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {pending.stale ? (
            <Button variant="primary" onClick={refresh} disabled={Boolean(busy)}>
              Preview again
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void apply()} disabled={Boolean(busy)}>
              {busy === 'apply' ? 'Saving…' : 'Apply'}
            </Button>
          )}
          <Button variant="ghost" onClick={cancel} disabled={busy === 'apply'}>
            Cancel
          </Button>
        </div>
        <SaveStatus track={applyTrack} onRetry={() => void apply()} />
      </div>
    ) : null;

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
      <a
        href={buildManageUrl(
          { scope: 'archive', section: 'artists' },
          typeof window !== 'undefined' ? window.location.pathname : '/app',
        )}
        onClick={(e) => {
          if (isModifiedClick(e)) return;
          e.preventDefault();
          onBack();
        }}
        className="inline-flex min-h-11 items-center text-sm text-accent hover:underline sm:min-h-9"
      >
        ← Back to artists
      </a>

      <Callout id="canonical-artist">
        Changes to the shared catalog are previewed first: nothing is saved until you press Apply. Undo is offered after each save.
      </Callout>

      <div className="space-y-2">
        <h3 className="font-display text-xl font-normal text-text">{artist.name}</h3>
        <div className="flex flex-wrap gap-1.5">
          {artist.origins.map((o) => (
            <Pill key={o} tone="neutral">{ORIGIN_LABEL[o]}</Pill>
          ))}
        </div>
        <p className="font-mono text-xs tabular-nums text-text-muted">
          {artist.mbid ? `MusicBrainz ${artist.mbid}` : 'No MusicBrainz id yet'} · {artist.editionsCount} billed{' '}
          {artist.editionsCount === 1 ? 'edition' : 'editions'} ·{' '}
          {artist.communityCount === null ? 'Community count not available' : `${artist.communityCount} community`}
        </p>
      </div>

      {problem && (
        <div role="alert" className="space-y-2 rounded-card border border-bad/45 bg-bad/10 p-3 text-sm text-bad">
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
            if (renamed) void preview('name', { op: 'rename', name: trimmed }, `Name: “${artist.name}” → “${trimmed}”`, normalizeName(trimmed));
          }}
        >
          <input
            className={control}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearPending('name');
            }}
            aria-label="Name"
          />
          <button type="submit" disabled={!renamed || Boolean(busy)} className={primary}>
            {busy === 'preview' && <Equalizer size="sm" />} Preview rename
          </button>
        </form>
        {renamed && (
          <p className="text-xs text-text-muted">
            Changes the shared catalog only; member events keep the names they typed. “{artist.name}” is kept as an AKA.
          </p>
        )}
        {pendingPanel('name')}
      </div>

      <div className="space-y-1.5">
        <h3 className={sectionTitle}>Also known as</h3>
        {artist.akas.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {artist.akas.map((a) => (
              <li key={a} className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-xs text-text-muted">
                {a}
                <IconButton
                  icon={X}
                  label={`Remove AKA ${a}`}
                  size="chip"
                  disabled={Boolean(busy)}
                  onClick={() => void preview('aka', { op: 'alias-remove', name: a }, `Also known as: remove “${a}”`, artist.key)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-muted">No AKAs yet.</p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (aka.trim()) void preview('aka', { op: 'alias-add', name: aka.trim() }, `Also known as: add “${aka.trim()}”`, artist.key);
          }}
        >
          <input
            className={control}
            value={aka}
            onChange={(e) => {
              setAka(e.target.value);
              clearPending('aka');
            }}
            placeholder="Another name or spelling"
            aria-label="Add an AKA"
          />
          <button type="submit" disabled={!akaSpelling || Boolean(busy)} className={quiet}>
            <Plus className="h-3.5 w-3.5" /> Preview
          </button>
        </form>
        <p className="text-xs text-text-muted">Lineups that name this artist by an AKA are matched to it.</p>
        {pendingPanel('aka')}
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
            <Ledger>
              {candidates.map((a) => (
                <Ledger.Row
                  key={a.key}
                  edge="none"
                  selected={target?.key === a.key}
                  onOpen={() => {
                    setTarget(a);
                    clearPending('merge');
                  }}
                  className="min-h-11 px-3 py-2 text-sm sm:min-h-9"
                >
                  <span className={target?.key === a.key ? 'font-medium text-accent' : 'text-text'}>{a.name}</span>
                  <span className="ml-auto text-xs text-text-faint">{a.mbid ? 'MusicBrainz' : 'No MusicBrainz id'}</span>
                </Ledger.Row>
              ))}
            </Ledger>
            {target && (
              <div className="space-y-2 rounded-card border border-line bg-surface-1 p-3 text-sm text-text-muted">
                <p>
                  “{artist.name}” merges into “{target.name}”, and “{artist.name}” becomes an AKA. Its editions and performances move to “{target.name}”.
                  Your own record of this artist follows too, when you have one. Member events are not changed. {mbidNote} You can undo it.
                </p>
                {pendingPanel('merge')}
                {!(pending && pending.section === 'merge') && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => void preview('merge', { op: 'merge', into: target.key }, `Merge: “${artist.name}” → “${target.name}”`, null)}
                      disabled={Boolean(busy)}
                      className={primary}
                    >
                      {busy === 'preview' ? <Equalizer size="sm" /> : <GitMerge className="h-3.5 w-3.5" />} Preview merge
                    </button>
                  </div>
                )}
                <button
                  onClick={() => {
                    setMerging(false);
                    setTarget(null);
                    setPick('');
                    setPending(null);
                  }}
                  className={quiet}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className={sectionTitle}>Appearances</h3>
        {appearances.length === 0 ? (
          <p className="text-sm text-text-muted">Not in any edition in the archive yet.</p>
        ) : (
          <Ledger>
            {appearances.map((a) => {
              const url = editionUrl(a.editionId);
              return (
                <Ledger.Row key={`${a.editionId}-${a.billing ?? ''}-${a.set ?? ''}`} edge="none" className="min-h-11 px-3 py-2.5 text-sm sm:min-h-9">
                  <a
                    href={url}
                    onClick={(e) => {
                      if (isModifiedClick(e)) return;
                      e.preventDefault();
                      window.history.pushState({ fromManageList: true }, '', url);
                      rememberManageSearch(new URL(url, window.location.origin).search);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                    className="font-medium text-text hover:text-accent hover:underline"
                  >
                    {a.editionName}
                  </a>
                  <span className="ml-2 font-mono text-xs tabular-nums text-text-muted">
                    {[a.billing ?? 'Artist', a.set, a.startDate, a.venue].filter(Boolean).join(' · ')}
                  </span>
                </Ledger.Row>
              );
            })}
          </Ledger>
        )}
      </div>
    </div>
  );
};
