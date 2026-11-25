import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Tags, X } from 'lucide-react';
import { genresApi, LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, genresByArtist } from '../services/genres';
import type { KnownGenre } from '../server/events/genreTypes';
import { SuggestInput } from './SuggestInput';

// Genres of the acts you saw at this event, in the event panel. Each act shows
// the genres the app found (music-story or MusicBrainz) or the ones you set.
// Adding or removing one makes the act's genres yours: the found ones are
// copied, then changed. Typing offers genres you already have; anything else
// is added as a new genre. See ARCHITECTURE.md ("Artist genres").

const SOURCE_NAMES: Record<ArtistGenres['source'], string> = {
  'music-story': 'music-story',
  musicbrainz: 'MusicBrainz',
  you: 'you',
};

const ActGenres: React.FC<{
  act: { key: string; name: string };
  own?: ArtistGenres;
  found?: ArtistGenres;
  known: KnownGenre[];
  onSave: (key: string, styles: string[] | null) => Promise<void>;
}> = ({ act, own, found, known, onSave }) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const shown = own ?? found;
  const styles = (shown?.genres ?? []).map((g) => g.style);
  const has = new Set(styles.map((s) => s.toLowerCase()));
  const offers = known.map((g) => g.style).filter((s) => !has.has(s.toLowerCase()));
  const save = (next: string[] | null) => {
    setError(null);
    onSave(act.key, next).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  const add = (value: string) => {
    const style = value.replace(/\s+/g, ' ').trim();
    setDraft('');
    if (style && !has.has(style.toLowerCase())) save([...styles, style]);
  };
  return (
    <li className="space-y-1 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-28 shrink-0 truncate text-sm text-text" title={act.name}>
          {act.name}
        </span>
        {styles.map((s) => (
          <span
            key={s}
            title={own ? 'Set by you' : `From ${SOURCE_NAMES[shown!.source]}`}
            className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs ${
              own ? 'bg-accent-tint text-accent' : 'bg-surface-2 text-text-muted'
            }`}
          >
            {s}
            <button
              onClick={() => save(styles.filter((x) => x !== s))}
              aria-label={`Remove ${s} from ${act.name}`}
              className="inline-flex min-h-11 items-center sm:min-h-9 text-text-muted hover:text-text"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {!styles.length && <span className="text-xs text-text-muted">{own ? 'None, as you set' : 'No genre yet'}</span>}
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
        {own && found?.genres.length ? (
          <button
            onClick={() => save(null)}
            title={`Show the genres from ${SOURCE_NAMES[found.source]} again: ${found.genres.map((g) => g.style).join(', ')}`}
            className="inline-flex min-h-11 items-center sm:min-h-9 text-[11px] text-text-muted hover:text-text-muted"
          >
            Use {SOURCE_NAMES[found.source]}'s
          </button>
        ) : null}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
};

export const SeenGenres: React.FC<{ event: LoggedEvent }> = ({ event }) => {
  const [rows, setRows] = useState<ArtistGenres[] | null>(null);
  const [known, setKnown] = useState<KnownGenre[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    genresApi
      .list()
      .then((r) => {
        setRows(r.genres);
        setKnown(r.known);
      })
      .catch(() => setRows(null)); // before 0013 is applied: no genres here
  }, [event.id]);
  const acts = useMemo(() => [...new Map(event.seen.map((s) => [s.key, { key: s.key, name: s.name }])).values()], [event.seen]);
  const found = useMemo(() => genresByArtist((rows ?? []).filter((r) => r.source !== 'you')), [rows]);
  const own = useMemo(() => new Map((rows ?? []).filter((r) => r.source === 'you').map((r) => [r.key, r])), [rows]);
  if (!rows || !acts.length) return null;
  const withGenre = acts.filter((a) => (own.get(a.key) ?? found.get(a.key))?.genres.length).length;

  const onSave = async (key: string, styles: string[] | null) => {
    if (styles === null) {
      await genresApi.resetOwn(key);
      setRows((prev) => (prev ?? []).filter((r) => !(r.key === key && r.source === 'you')));
      return;
    }
    const row = await genresApi.setOwn(key, styles);
    setRows((prev) => [...(prev ?? []).filter((r) => !(r.key === key && r.source === 'you')), row]);
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
        <ul className="divide-y divide-line pt-1">
          {acts.map((a) => (
            <ActGenres key={a.key} act={a} own={own.get(a.key)} found={found.get(a.key)} known={known} onSave={onSave} />
          ))}
        </ul>
      )}
    </div>
  );
};
