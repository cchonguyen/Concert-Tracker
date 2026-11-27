import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { genresApi } from '../services/lineupApi';
import type { GenreMapEntry, GenreVocabulary, KnownGenre } from '../server/events/genreTypes';
import { ArtistGenres, genresByArtist } from '../services/genres';
import { IconButton } from './ui/IconButton';
import { SuggestInput } from './SuggestInput';
import { useIsOwner } from './MeContext';

const control =
  'min-h-11 sm:min-h-9 w-full rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';
const quiet =
  'inline-flex min-h-11 sm:min-h-9 shrink-0 items-center gap-1 rounded-control border border-line-strong px-2.5 py-1.5 text-sm text-text-muted hover:text-text disabled:opacity-40';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';

const SOURCE_NAMES: Record<ArtistGenres['source'], string> = {
  'music-story': 'music-story',
  musicbrainz: 'MusicBrainz',
  you: 'the site owner',
  owner: 'the site owner',
  added: 'you',
};

// Genre editor for one artist record (shared by My records and Global archive).
// Owners edit the shared genres (logged, with Undo); members add their own on top.
export const ArtistGenresEditor: React.FC<{ actKey: string }> = ({ actKey }) => {
  const isOwner = useIsOwner();
  const [rows, setRows] = useState<ArtistGenres[] | null>(null);
  const [known, setKnown] = useState<KnownGenre[]>([]);
  const [hasMap, setHasMap] = useState(false);
  const [vocabulary, setVocabulary] = useState<GenreVocabulary | undefined>(undefined);
  const [map, setMap] = useState<GenreMapEntry[] | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDraft('');
    setError(null);
    genresApi
      .list()
      .then((r) => {
        if (cancelled) return;
        setRows(r.genres);
        setKnown(r.known);
        setHasMap(r.hasMap);
        setVocabulary(r.vocabulary);
        setMap(r.map);
      })
      .catch(() => {
        if (!cancelled) setRows(null);
      });
    return () => {
      cancelled = true;
    };
  }, [actKey]);

  const actRows = useMemo(() => (rows ?? []).filter((r) => r.key === actKey), [rows, actKey]);
  const combined = useMemo(() => genresByArtist(rows ?? [], vocabulary, map).get(actKey), [rows, actKey, vocabulary, map]);
  const sharedBase = useMemo(
    () => genresByArtist((rows ?? []).filter((r) => r.source !== 'added'), vocabulary, map).get(actKey),
    [rows, actKey, vocabulary, map],
  );
  const own = useMemo(
    () => actRows.find((r) => r.source === 'owner') ?? actRows.find((r) => r.source === 'you'),
    [actRows],
  );
  const found = useMemo(
    () =>
      genresByArtist(
        (rows ?? []).filter((r) => r.source !== 'owner' && r.source !== 'you' && r.source !== 'added'),
        vocabulary,
        map,
      ).get(actKey),
    [rows, actKey, vocabulary, map],
  );

  const shown = sharedBase;
  const sharedStyles = (shown?.genres ?? []).map((g) => g.style);
  const addedStyles = isOwner ? [] : (combined?.added ?? []);
  const styles = isOwner ? sharedStyles : [...sharedStyles, ...addedStyles];
  const has = new Set(styles.map((s) => s.toLowerCase()));
  const offers = known.map((g) => g.style).filter((s) => !has.has(s.toLowerCase()));

  const lastChangedAt = useMemo(() => {
    const times = actRows
      .filter((r) => r.source !== 'added' && r.checkedAt)
      .map((r) => r.checkedAt)
      .sort();
    return times.length ? times[times.length - 1] : null;
  }, [actRows]);

  const save = async (next: string[] | null) => {
    const matchSource = (r: ArtistGenres) => (isOwner ? r.source === 'owner' || r.source === 'you' : r.source === 'added');
    setBusy(true);
    setError(null);
    try {
      if (next === null) {
        await genresApi.resetOwn(actKey);
        setRows((prev) => (prev ?? []).filter((r) => !(r.key === actKey && matchSource(r))));
      } else {
        const row = await genresApi.setOwn(actKey, next);
        setRows((prev) => [...(prev ?? []).filter((r) => !(r.key === actKey && matchSource(r))), row]);
        setKnown((prev) =>
          row.genres.reduce(
            (list, g) => (list.some((k) => k.style.toLowerCase() === g.style.toLowerCase()) ? list : [...list, { style: g.style, parent: g.parent }]),
            prev,
          ),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (value: string) => {
    const style = value.replace(/\s+/g, ' ').trim();
    setDraft('');
    if (!style || has.has(style.toLowerCase())) return;
    void save(isOwner ? [...sharedStyles, style] : [...addedStyles, style]);
  };

  // Moves one of the owner's genres up or down; the saved order is the rank.
  const moveOwn = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= sharedStyles.length) return;
    const next = [...sharedStyles];
    [next[index], next[to]] = [next[to], next[index]];
    void save(next);
  };

  const lookupMb = async () => {
    setBusy(true);
    setError(null);
    try {
      const got = await genresApi.musicBrainz([actKey]);
      setRows((prev) => [...(prev ?? []).filter((r) => !got.some((g) => g.key === r.key && g.source === r.source)), ...got]);
      if (!got.some((g) => g.genres.length)) {
        setError('No genres found on MusicBrainz for this artist.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const undoLastChange = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await genresApi.undo(actKey);
      setRows((prev) => [...(prev ?? []).filter((r) => !(r.key === actKey && r.source !== 'added')), ...res.rows]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return null;

  const sharedTooltip = (source: ArtistGenres['source']) => {
    if (source === 'owner' || source === 'you') return isOwner ? 'Set by you' : 'Set by the site owner';
    return `From ${SOURCE_NAMES[source]}`;
  };

  return (
    <div className="space-y-1.5">
      <h3 className={sectionTitle}>Genres</h3>
      {styles.length > 0 && (
        <ul className="flex flex-wrap items-center gap-1.5">
          {sharedStyles.map((s, i) => (
            <li
              key={`shared-${s}`}
              title={isOwner && own ? 'Set by you' : sharedTooltip(shown!.source)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                isOwner && own
                  ? 'border-accent-tint-line bg-accent-tint text-accent'
                  : 'border-line-strong bg-surface-1 text-text-muted'
              }`}
            >
              {isOwner && own && sharedStyles.length > 1 && (
                <IconButton
                  icon={ChevronUp}
                  label="Move up"
                  size="chip"
                  disabled={busy || i === 0}
                  onClick={() => moveOwn(i, -1)}
                />
              )}
              {s}
              {isOwner && own && sharedStyles.length > 1 && (
                <IconButton
                  icon={ChevronDown}
                  label="Move down"
                  size="chip"
                  disabled={busy || i === sharedStyles.length - 1}
                  onClick={() => moveOwn(i, 1)}
                />
              )}
              {isOwner && (
                <IconButton
                  icon={X}
                  label={`Remove genre ${s}`}
                  size="chip"
                  disabled={busy}
                  onClick={() => void save(sharedStyles.filter((x) => x !== s))}
                />
              )}
            </li>
          ))}
          {!isOwner &&
            addedStyles.map((s) => (
              <li
                key={`added-${s}`}
                title="Added by you"
                className="inline-flex items-center gap-1 rounded-full border border-accent-tint-line bg-accent-tint px-2 py-0.5 text-xs text-accent"
              >
                {s}
                <IconButton
                  icon={X}
                  label={`Remove genre ${s}`}
                  size="chip"
                  disabled={busy}
                  onClick={() => {
                    const next = addedStyles.filter((x) => x !== s);
                    void save(next.length ? next : null);
                  }}
                />
              </li>
            ))}
          {isOwner && own && found?.genres.length ? (
            <li>
              <button
                type="button"
                onClick={() => void save(null)}
                disabled={busy}
                title={`Show the genres from ${SOURCE_NAMES[found.source]} again: ${found.genres.map((g) => g.style).join(', ')}`}
                className="text-xs text-text-muted hover:text-accent"
              >
                Use {SOURCE_NAMES[found.source]}'s
              </button>
            </li>
          ) : null}
          {!isOwner && addedStyles.length > 0 && (
            <li>
              <button
                type="button"
                onClick={() => void save(null)}
                disabled={busy}
                className="text-xs text-text-muted hover:text-accent"
              >
                Remove my genres
              </button>
            </li>
          )}
        </ul>
      )}
      {!styles.length && (
        <p className="text-xs text-text-muted">
          {isOwner && own
            ? 'None, as you set.'
            : found?.source === 'musicbrainz'
              ? 'Checked on MusicBrainz: no genre found.'
              : 'No genre yet.'}
          {isOwner && own && found?.genres.length ? (
            <button
              type="button"
              onClick={() => void save(null)}
              disabled={busy}
              className="ml-2 text-text-muted hover:text-accent"
            >
              Use {SOURCE_NAMES[found.source]}'s
            </button>
          ) : null}
          {isOwner && hasMap && !own && (!found || (!found.genres.length && found.source !== 'musicbrainz')) ? (
            <button
              type="button"
              onClick={() => void lookupMb()}
              disabled={busy}
              className="ml-2 text-text-muted hover:text-accent"
            >
              Look up on MusicBrainz
            </button>
          ) : null}
        </p>
      )}
      <form
        className="flex max-w-sm gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) add(draft);
        }}
      >
        <div className="w-full">
          <SuggestInput
            value={draft}
            suggestions={offers}
            placeholder="Add a genre"
            aria-label="Add a genre"
            className={control}
            onChange={(e) => setDraft(e.target.value)}
            onPick={add}
          />
        </div>
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          className={quiet}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </form>
      <p className="text-xs text-text-muted">
        {isOwner ? (
          <>
            {own
              ? 'Set by you; overrides imported genres.'
              : shown
                ? `From ${SOURCE_NAMES[shown.source]}. Editing sets the shared genres.`
                : 'Genres you set here are shown to everyone.'}
            {lastChangedAt && (
              <>
                {' '}
                Last change: {new Date(lastChangedAt).toLocaleDateString()}.{' '}
                <button
                  type="button"
                  onClick={() => void undoLastChange()}
                  disabled={busy}
                  className="text-text-muted underline hover:text-accent"
                >
                  Undo
                </button>
              </>
            )}
          </>
        ) : (
          'Shared genres are set by the site owner. Genres you add show only to you.'
        )}
      </p>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
};
