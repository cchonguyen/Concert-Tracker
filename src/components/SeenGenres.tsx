import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Tags, X } from 'lucide-react';
import { genresApi, LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, genresByArtist } from '../services/genres';
import type { GenreMapEntry, GenreVocabulary, KnownGenre } from '../server/events/genreTypes';
import { SuggestInput } from './SuggestInput';
import { useIsOwner } from './MeContext';

// Genres of the acts you saw at this event, in the event panel. Shared genres
// come from music-story, MusicBrainz, or the site owner. The owner edits the
// shared genres; members see the shared ones as plain pills and can add their
// own on top, shown only to them. See ARCHITECTURE.md ("Artist genres").

const SOURCE_NAMES: Record<ArtistGenres['source'], string> = {
  'music-story': 'music-story',
  musicbrainz: 'MusicBrainz',
  you: 'the site owner',
  owner: 'the site owner',
  added: 'you',
};

const ActGenres: React.FC<{
  act: { key: string; name: string };
  isOwner: boolean;
  own?: ArtistGenres;
  found?: ArtistGenres;
  shared?: ArtistGenres;
  added: string[];
  known: KnownGenre[];
  onSave: (key: string, styles: string[] | null) => Promise<void>;
}> = ({ act, isOwner, own, found, shared, added, known, onSave }) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const shown = shared;
  const sharedStyles = (shown?.genres ?? []).map((g) => g.style);
  const styles = isOwner ? sharedStyles : [...sharedStyles, ...added];
  const has = new Set(styles.map((s) => s.toLowerCase()));
  const offers = known.map((g) => g.style).filter((s) => !has.has(s.toLowerCase()));
  const save = (next: string[] | null) => {
    setError(null);
    onSave(act.key, next).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  const add = (value: string) => {
    const style = value.replace(/\s+/g, ' ').trim();
    setDraft('');
    if (!style || has.has(style.toLowerCase())) return;
    save(isOwner ? [...sharedStyles, style] : [...added, style]);
  };
  const sharedTooltip = (source: ArtistGenres['source']) => {
    if (source === 'owner' || source === 'you') return isOwner ? 'Set by you' : 'Set by the site owner';
    return `From ${SOURCE_NAMES[source]}`;
  };
  return (
    <li className="space-y-1 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-28 shrink-0 truncate text-sm text-text" title={act.name}>
          {act.name}
        </span>
        {sharedStyles.map((s) => (
          <span
            key={`shared-${s}`}
            title={isOwner && own ? 'Set by you' : sharedTooltip(shown!.source)}
            className={`inline-flex items-center gap-1 rounded-full py-0.5 text-xs ${
              isOwner && own
                ? 'bg-accent-tint pl-2 pr-1 text-accent'
                : isOwner
                  ? 'bg-surface-2 pl-2 pr-1 text-text-muted'
                  : 'bg-surface-2 px-2 text-text-muted'
            }`}
          >
            {s}
            {isOwner && (
              <button
                onClick={() => save(sharedStyles.filter((x) => x !== s))}
                aria-label={`Remove ${s} from ${act.name}`}
                className="inline-flex min-h-11 items-center sm:min-h-9 text-text-muted hover:text-text"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {!isOwner &&
          added.map((s) => (
            <span
              key={`added-${s}`}
              title="Added by you"
              className="inline-flex items-center gap-1 rounded-full bg-accent-tint py-0.5 pl-2 pr-1 text-xs text-accent"
            >
              {s}
              <button
                onClick={() => {
                  const next = added.filter((x) => x !== s);
                  save(next.length ? next : null);
                }}
                aria-label={`Remove ${s} from ${act.name}`}
                className="inline-flex min-h-11 items-center sm:min-h-9 text-text-muted hover:text-text"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        {!styles.length && (
          <span className="text-xs text-text-muted">{isOwner && own ? 'None, as you set' : 'No genre yet'}</span>
        )}
        <div className="w-36">
          <SuggestInput
            value={draft}
            suggestions={offers}
            placeholder="Add genre"
            aria-label={`Add a genre to ${act.name}`}
            className="w-full rounded-control border border-line bg-page px-2 py-0.5 text-xs text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
            onChange={(e) => setDraft(e.target.value)}
            onPick={add}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(draft);
              }
            }}
          />
        </div>
        {isOwner && own && found?.genres.length ? (
          <button
            onClick={() => save(null)}
            title={`Show the genres from ${SOURCE_NAMES[found.source]} again: ${found.genres.map((g) => g.style).join(', ')}`}
            className="inline-flex min-h-11 items-center sm:min-h-9 text-[11px] text-text-muted hover:text-text-muted"
          >
            Use {SOURCE_NAMES[found.source]}'s
          </button>
        ) : null}
        {!isOwner && added.length > 0 && (
          <button
            onClick={() => save(null)}
            className="inline-flex min-h-11 items-center sm:min-h-9 text-[11px] text-text-muted hover:text-text"
          >
            Remove my genres
          </button>
        )}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
};

export const SeenGenres: React.FC<{ event: LoggedEvent }> = ({ event }) => {
  const isOwner = useIsOwner();
  const [rows, setRows] = useState<ArtistGenres[] | null>(null);
  const [known, setKnown] = useState<KnownGenre[]>([]);
  const [vocabulary, setVocabulary] = useState<GenreVocabulary | undefined>(undefined);
  const [map, setMap] = useState<GenreMapEntry[] | undefined>(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    genresApi
      .list()
      .then((r) => {
        setRows(r.genres);
        setKnown(r.known);
        setVocabulary(r.vocabulary);
        setMap(r.map);
      })
      .catch(() => setRows(null)); // before 0013 is applied: no genres here
  }, [event.id]);
  const acts = useMemo(() => [...new Map(event.seen.map((s) => [s.key, { key: s.key, name: s.name }])).values()], [event.seen]);
  const combined = useMemo(() => genresByArtist(rows ?? [], vocabulary, map), [rows, vocabulary, map]);
  const sharedBase = useMemo(() => genresByArtist((rows ?? []).filter((r) => r.source !== 'added'), vocabulary, map), [rows, vocabulary, map]);
  const found = useMemo(
    () => genresByArtist((rows ?? []).filter((r) => r.source !== 'owner' && r.source !== 'you' && r.source !== 'added'), vocabulary, map),
    [rows, vocabulary, map],
  );
  const own = useMemo(() => {
    const m = new Map<string, ArtistGenres>();
    for (const r of rows ?? []) if (r.source === 'you') m.set(r.key, r);
    for (const r of rows ?? []) if (r.source === 'owner') m.set(r.key, r);
    return m;
  }, [rows]);
  if (!rows || !acts.length) return null;
  const withGenre = acts.filter((a) => combined.get(a.key)?.genres.length).length;

  const onSave = async (key: string, styles: string[] | null) => {
    const matchSource = (r: ArtistGenres) => (isOwner ? r.source === 'owner' || r.source === 'you' : r.source === 'added');
    if (styles === null) {
      await genresApi.resetOwn(key);
      setRows((prev) => (prev ?? []).filter((r) => !(r.key === key && matchSource(r))));
      return;
    }
    const row = await genresApi.setOwn(key, styles);
    setRows((prev) => [...(prev ?? []).filter((r) => !(r.key === key && matchSource(r))), row]);
    setKnown((prev) =>
      row.genres.reduce(
        (list, g) => (list.some((k) => k.style.toLowerCase() === g.style.toLowerCase()) ? list : [...list, { style: g.style, parent: g.parent }]),
        prev,
      ),
    );
  };

  return (
    <div className="rounded-control border border-line bg-surface-1 p-2">
      <button onClick={() => setOpen(!open)} className="min-h-11 sm:min-h-9 flex w-full items-center gap-1.5 text-left text-xs text-text-muted hover:text-text">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Tags className="h-3.5 w-3.5" /> Genres
        <span className="text-text-muted">
          {withGenre} of {acts.length} {acts.length === 1 ? 'act' : 'acts'}
        </span>
      </button>
      {open && (
        <>
          <ul className="divide-y divide-line pt-1">
            {acts.map((a) => (
              <ActGenres
                key={a.key}
                act={a}
                isOwner={isOwner}
                own={own.get(a.key)}
                found={found.get(a.key)}
                shared={sharedBase.get(a.key)}
                added={combined.get(a.key)?.added ?? []}
                known={known}
                onSave={onSave}
              />
            ))}
          </ul>
          {!isOwner && (
            <p className="pt-1.5 text-[11px] text-text-muted">
              Shared genres are set by the site owner. Genres you add show only to you.
            </p>
          )}
        </>
      )}
    </div>
  );
};
