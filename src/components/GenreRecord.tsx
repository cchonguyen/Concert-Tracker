import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { genresApi, type GenresList } from '../services/lineupApi';
import { genresByArtist } from '../services/genres';
import { genreKey, genreResolver, NOT_GROUPED } from '../server/events/genreVocabulary';
import { canonicalArtistUrl, isModifiedClick, rememberManageSearch } from '../services/manageNav';
import type { GenreVocabChange } from '../server/events/genreTypes';
import type { GenreMergePlan } from '../server/events/genreVocabularyManage';
import type { GenreListRow } from './GenresPanel';
import { Button } from './ui/Button';
import { Equalizer } from './ui/Equalizer';
import { IconButton } from './ui/IconButton';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';
import { Pill } from './ui/Pill';

// A genre's record in Manage > Global archive > Genres (docs/specs/genre-vocabulary.md
// section 6): name, other spellings, group, umbrellas, merge and history. Every write
// goes to the server, which refuses with the spec's lines; those are shown as they come.

const field =
  'min-h-11 sm:min-h-9 rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// The server's "Merge instead" refusal names the genre that already holds the spelling.
const MERGE_INSTEAD = /That is already a genre: (.+)\. Merge instead\./;
// The select's value for "no owner's group": the genre map decides again.
const FROM_MAP = '';
const ARTISTS_PREVIEW_LIMIT = 30;

const Heading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{children}</h4>
);

export const GenreRecord: React.FC<{
  row: GenreListRow;
  rows: GenreListRow[];
  groups: string[];
  data: GenresList;
  // A change was saved: the panel shows its notice with Undo, reloads, and opens `selectKey` when given.
  onChanged: (change: GenreVocabChange, selectKey?: string) => Promise<void>;
  onSelect: (key: string) => void;
  onClose: () => void;
}> = ({ row, rows, groups, data, onChanged, onSelect, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The genre a "Merge instead" refusal named, offered as a merge target.
  const [mergeOffer, setMergeOffer] = useState<string | null>(null);
  const [name, setName] = useState(row.name);
  const [alias, setAlias] = useState('');
  const [umbrellaQuery, setUmbrellaQuery] = useState('');
  const [merging, setMerging] = useState(false);
  const [target, setTarget] = useState('');
  const [plan, setPlan] = useState<GenreMergePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [showAllArtists, setShowAllArtists] = useState(false);

  // A different genre opened: start its record afresh.
  useEffect(() => {
    setName(row.name);
    setAlias('');
    setUmbrellaQuery('');
    setMerging(false);
    setTarget('');
    setPlan(null);
    setError(null);
    setMergeOffer(null);
    setShowAllArtists(false);
  }, [row.key, row.name]);

  const vocab = useMemo(() => data.vocabulary.genres.find((g) => g.key === row.key), [data, row.key]);
  const mapGroup = useMemo(() => data.map.find((m) => genreKey(m.style) === row.key)?.parent, [data, row.key]);
  const nameOf = (key: string) => rows.find((r) => r.key === key)?.name ?? key;
  const umbrellaKeys = vocab?.umbrellas ?? [];
  const under = useMemo(
    () => data.vocabulary.genres.filter((g) => g.umbrellas.includes(row.key)).map((g) => ({ key: g.key, name: nameOf(g.key) })),
    [data, row.key, rows],
  );
  const connectedArtists = useMemo(() => {
    const shared = data.genres.filter((r) => r.source !== 'added');
    const resolver = genreResolver(data.vocabulary, data.map, shared);
    const byArtist = genresByArtist(shared, data.vocabulary, data.map);
    const out: Array<{ key: string; name: string }> = [];
    for (const [key, artist] of byArtist) {
      if (artist.genres.some((g) => resolver.resolve(g.style).key === row.key)) {
        out.push({ key, name: artist.name });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [data, row.key]);
  // Spellings joined by the key alone (same letters), not by an alias the owner added.
  const folded = row.spellings.filter((s) => s !== row.name && !row.aliases.includes(s) && genreKey(s) === row.key);

  const umbrellaMatches = useMemo(() => {
    const q = umbrellaQuery.trim().toLowerCase();
    if (!q) return [];
    return rows
      .filter((r) => r.key !== row.key && !umbrellaKeys.includes(r.key))
      .filter((r) => [r.name, ...r.aliases].some((n) => n.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [rows, row.key, umbrellaKeys, umbrellaQuery]);

  // The vocabulary changes that touch this genre (by its key or one of its alias keys), newest first.
  const history = useMemo(() => {
    const keys = new Set([row.key, ...(vocab?.aliases.map((a) => a.key) ?? [])]);
    return (data.vocabularyChanges ?? [])
      .filter((c) => [...c.before, ...c.after].some((g) => keys.has(g.key)))
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [data, row.key, vocab]);
  const newestOpen = history.find((c) => !c.undoneAt)?.id;

  const act = async (action: () => Promise<GenreVocabChange>, selectKey?: () => string | undefined): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setMergeOffer(null);
    try {
      const change = await action();
      await onChanged(change, selectKey?.());
      return true;
    } catch (err) {
      const msg = messageOf(err);
      setError(msg);
      setMergeOffer(MERGE_INSTEAD.exec(msg)?.[1] ?? null);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const preview = async (keep: string) => {
    setTarget(keep);
    setPlan(null);
    setError(null);
    if (!keep) return;
    setPlanLoading(true);
    try {
      setPlan(await genresApi.previewGenreMerge(row.name, keep));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPlanLoading(false);
    }
  };

  const startMerge = (keepName: string) => {
    setMerging(true);
    const keep = rows.find((r) => r.key === genreKey(keepName) || r.aliases.some((a) => genreKey(a) === genreKey(keepName)));
    void preview(keep?.name ?? keepName);
  };

  const groupValue = vocab?.parent ?? FROM_MAP;
  const fromMapLabel = mapGroup ? `From music-story (${mapGroup})` : NOT_GROUPED;

  return (
    <div className="space-y-4 rounded-card border border-line bg-surface-1 p-3" data-genre-record-slot={row.key}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-xl font-normal text-text">{row.name}</h3>
          <Pill tone={row.group === NOT_GROUPED ? 'neutral' : 'accent'}>{row.group}</Pill>
          <span className="font-mono text-xs tabular-nums text-text-muted">
            {row.artists} {row.artists === 1 ? 'artist' : 'artists'}
          </span>
        </div>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>

      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <Notice tone="warning">{error}</Notice>
          {mergeOffer && (
            <Button onClick={() => startMerge(mergeOffer)} disabled={busy}>
              Merge into {mergeOffer}
            </Button>
          )}
        </div>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const next = name.trim();
          void act(() => genresApi.renameGenre(row.name, next), () => genreKey(next));
        }}
      >
        <Heading>Name</Heading>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Genre name" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === row.name}>
            Rename
          </Button>
        </div>
      </form>

      <div className="space-y-1.5">
        <Heading>Other spellings</Heading>
        {row.aliases.length === 0 && folded.length === 0 && <p className="text-sm text-text-muted">None yet.</p>}
        {row.aliases.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {row.aliases.map((a) => (
              <li key={a} className="flex items-center gap-0.5 rounded-full border border-line pl-2 text-sm text-text">
                {a}
                <IconButton
                  icon={X}
                  size="chip"
                  label={`Remove ${a}`}
                  disabled={busy}
                  onClick={() => void act(() => genresApi.removeGenreAlias(row.name, a))}
                />
              </li>
            ))}
          </ul>
        )}
        {folded.length > 0 && (
          <p className="text-sm text-text-faint">
            {folded.join(', ')} <span className="text-xs">Same letters; joined on its own.</span>
          </p>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => genresApi.addGenreAlias(row.name, alias.trim())).then((ok) => ok && setAlias(''));
          }}
        >
          <input
            aria-label="New spelling"
            className={field}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="Another spelling"
            maxLength={80}
          />
          <Button type="submit" disabled={busy || !alias.trim()}>
            Add spelling
          </Button>
        </form>
      </div>

      <div className="space-y-1.5">
        <Heading>Group</Heading>
        <select
          aria-label="Genre group"
          className={field}
          value={groupValue}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            void act(() => genresApi.setGenreParent(row.name, v === FROM_MAP ? null : v));
          }}
        >
          <option value={FROM_MAP}>{fromMapLabel}</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Heading>Under these umbrellas</Heading>
        {umbrellaKeys.length === 0 ? (
          <p className="text-sm text-text-muted">None.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {umbrellaKeys.map((k) => (
              <li key={k} className="flex items-center gap-0.5 rounded-full border border-line pl-2 text-sm text-text">
                {nameOf(k)}
                <IconButton
                  icon={X}
                  size="chip"
                  label={`Remove ${nameOf(k)}`}
                  disabled={busy}
                  onClick={() => void act(() => genresApi.removeGenreUmbrella(row.name, nameOf(k)))}
                />
              </li>
            ))}
          </ul>
        )}
        <input
          aria-label="Find an umbrella genre"
          className={field}
          value={umbrellaQuery}
          onChange={(e) => setUmbrellaQuery(e.target.value)}
          placeholder="Find a genre to put this under"
          maxLength={80}
        />
        {umbrellaMatches.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {umbrellaMatches.map((m) => (
              <li key={m.key}>
                <Button
                  onClick={() => void act(() => genresApi.addGenreUmbrella(row.name, m.name)).then((ok) => ok && setUmbrellaQuery(''))}
                  disabled={busy}
                >
                  Under {m.name}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <Heading>Genres under this one</Heading>
        {under.length === 0 ? (
          <p className="text-sm text-text-muted">None.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {under.map((g) => (
              <li key={g.key}>
                <button type="button" className="text-sm text-accent hover:underline" onClick={() => onSelect(g.key)}>
                  {g.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <Heading>Artists{connectedArtists.length > 0 ? ` (${connectedArtists.length})` : ''}</Heading>
        {connectedArtists.length === 0 ? (
          <p className="text-sm text-text-muted">None yet.</p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {(showAllArtists ? connectedArtists : connectedArtists.slice(0, ARTISTS_PREVIEW_LIMIT)).map((a) => {
                const url = canonicalArtistUrl(a.key);
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
                      className="text-sm text-accent hover:underline"
                    >
                      {a.name}
                    </a>
                  </li>
                );
              })}
            </ul>
            {connectedArtists.length > ARTISTS_PREVIEW_LIMIT && (
              <button
                type="button"
                className="text-xs text-text-muted hover:text-accent"
                onClick={() => setShowAllArtists((v) => !v)}
              >
                {showAllArtists ? 'Show fewer' : `Show all ${connectedArtists.length} artists`}
              </button>
            )}
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <Button onClick={() => (merging ? (setMerging(false), setTarget(''), setPlan(null)) : setMerging(true))} disabled={busy}>
          {merging ? 'Cancel merge' : 'Merge into another genre'}
        </Button>
        {merging && (
          <div className="space-y-2 rounded-card border border-warn/45 bg-warn/10 p-3 text-sm">
            <p className="font-semibold text-text">Merge "{row.name}" into another genre</p>
            <select aria-label="Genre to keep" className={`${field} min-w-[14rem]`} value={target} onChange={(e) => void preview(e.target.value)}>
              <option value="">Choose the genre to keep…</option>
              {rows
                .filter((r) => r.key !== row.key)
                .map((r) => (
                  <option key={r.key} value={r.name}>
                    {r.name}
                  </option>
                ))}
            </select>
            {planLoading && <Equalizer size="sm" />}
            {plan && (
              <div className="space-y-1 text-text">
                <p>
                  {plan.artists} {plan.artists === 1 ? 'artist moves' : 'artists move'} to {plan.keep.name}.
                </p>
                {plan.aliases.length > 0 && <p>Become spellings of {plan.keep.name}: {plan.aliases.join(', ')}</p>}
                {plan.umbrellasMoved.length > 0 && (
                  <p>Umbrella links moved: {plan.umbrellasMoved.map((l) => `${l.genre} under ${l.umbrella}`).join(', ')}</p>
                )}
                {plan.umbrellasDropped.length > 0 && (
                  <p>Umbrella links dropped: {plan.umbrellasDropped.map((l) => `${l.genre} under ${l.umbrella}`).join(', ')}</p>
                )}
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => genresApi.mergeGenres(row.name, plan.keep.name).then((r) => r.change),
                      () => plan.keep.key,
                    )
                  }
                >
                  {busy && <Equalizer size="sm" />} Merge
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Heading>History</Heading>
        {history.length === 0 ? (
          <p className="text-sm text-text-muted">No changes yet.</p>
        ) : (
          <Ledger>
            {history.map((c) => (
              <Ledger.Row key={c.id} className="text-sm">
                <div className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={c.undoneAt ? 'text-text-faint line-through' : 'text-text'}>{c.summary}</span>
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">{when(c.at)}</span>
                  {c.undoneAt && <span className="font-mono text-[11px] tabular-nums text-text-muted">Undone {when(c.undoneAt)}</span>}
                  {c.id === newestOpen && (
                    <span className="ml-auto">
                      <Button onClick={() => void act(() => genresApi.undoVocabulary(c.id))} disabled={busy}>
                        Undo
                      </Button>
                    </span>
                  )}
                </div>
              </Ledger.Row>
            ))}
          </Ledger>
        )}
      </div>
    </div>
  );
};
