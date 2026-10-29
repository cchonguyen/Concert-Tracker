import { Dialog } from './ui/Dialog';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Loader2, Square, Tags, X } from 'lucide-react';
import { genresApi, LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, genresByArtist, missingGenreKeys } from '../services/genres';
import { MAX_MUSICBRAINZ_GENRES } from '../server/events/genreTypes';

// "Artist genres" in the Table view: import the file music-story exports from
// your listening history, then, if you ask, look up the acts it does not
// cover on MusicBrainz. See ARCHITECTURE.md ("Artist genres").

interface ArtistGenresPanelProps {
  events: LoggedEvent[];
  onClose: () => void;
}

const button =
  'inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';
const primary =
  'inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40';

export const ArtistGenresPanel: React.FC<ArtistGenresPanelProps> = ({ events, onClose }) => {
  const [rows, setRows] = useState<ArtistGenres[] | null>(null);
  const [hasMap, setHasMap] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stop = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () =>
    genresApi
      .list()
      .then((r) => {
        setRows(r.genres);
        setHasMap(r.hasMap);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    void load();
  }, []);

  const seenKeys = useMemo(() => new Set(events.flatMap((e) => e.seen.map((s) => s.key))), [events]);
  const by = useMemo(() => genresByArtist(rows ?? []), [rows]);
  const known = [...seenKeys].filter((k) => by.get(k)?.genres.length);
  const fromFile = known.filter((k) => by.get(k)?.source === 'music-story').length;
  const fromYou = known.filter((k) => by.get(k)?.source === 'you').length;
  const missing = useMemo(() => missingGenreKeys(events, rows ?? []), [events, rows]);
  const checkedNone = [...seenKeys].filter((k) => by.get(k) && !by.get(k)!.genres.length && by.get(k)!.source === 'musicbrainz').length;

  const importFile = async (file: File) => {
    setBusy('import');
    setError(null);
    setMessage(null);
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not JSON. Pick build/artist_genres.json from music-story.');
      }
      const r = await genresApi.importMusicStory(data);
      setMessage(
        `Matched ${r.matched} of the ${r.seen} acts you saw. The file lists ${r.inFile.toLocaleString()} artists with a genre; the others are not kept.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const lookUp = async () => {
    const keys = missing;
    stop.current = false;
    setBusy('musicbrainz');
    setError(null);
    setMessage(null);
    setProgress({ done: 0, total: keys.length });
    let found = 0;
    let done = 0;
    try {
      for (let i = 0; i < keys.length && !stop.current; i += MAX_MUSICBRAINZ_GENRES) {
        const got = await genresApi.musicBrainz(keys.slice(i, i + MAX_MUSICBRAINZ_GENRES));
        found += got.filter((g) => g.genres.length).length;
        done += got.length;
        setRows((prev) => [...(prev ?? []).filter((r) => !got.some((g) => g.key === r.key && g.source === r.source)), ...got]);
        setProgress({ done: Math.min(i + MAX_MUSICBRAINZ_GENRES, keys.length), total: keys.length });
      }
      setMessage(`MusicBrainz had genres for ${found} of the ${done} acts looked up${stop.current ? ' before you stopped' : ''}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <Dialog title="Genres" onClose={onClose}>
      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Tags className="h-4 w-4 text-violet-400" /> Artist genres
            </h2>
            <p className="text-xs text-zinc-500">
              Genres for the acts you saw, from your music-story listening history first, then MusicBrainz for acts it does not
              cover. Acts neither one knows stay without a genre.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}
        {message && <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2 text-sm text-emerald-200">{message}</p>}

        {!rows ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading
          </p>
        ) : (
          <>
            <section className="rounded-xl border border-zinc-900 p-4 text-sm">
              <p className="text-zinc-200">
                Genres known for <strong>{known.length}</strong> of the {seenKeys.size} acts you saw.
              </p>
              <p className="text-xs text-zinc-500">
                {fromFile} from music-story, {known.length - fromFile - fromYou} from MusicBrainz{fromYou ? `, ${fromYou} set by you` : ''}
                {checkedNone ? `, ${checkedNone} looked up with none found` : ''}.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-zinc-200">1. Import from music-story</h3>
              <p className="text-xs text-zinc-500">
                In music-story, after a build, run <code className="text-zinc-300">uv run python -m pipeline.artist_genre export</code>{' '}
                and pick the file it writes, <code className="text-zinc-300">build/artist_genres.json</code>. Importing again replaces
                the genres it gave before.
              </p>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
              />
              <button className={primary} disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
                {busy === 'import' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} Choose file
              </button>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-zinc-200">2. Look up the rest on MusicBrainz</h3>
              <p className="text-xs text-zinc-500">
                {hasMap
                  ? `${missing.length === 1 ? '1 act has' : `${missing.length} acts have`} no genre from music-story and ${missing.length === 1 ? 'has' : 'have'} not been looked up. Each takes a few seconds; only an exact, unambiguous name match is used, and its genres are read through music-story's genre map.`
                  : 'Import the music-story file first: its genre map is how MusicBrainz genres are read.'}
              </p>
              {busy === 'musicbrainz' ? (
                <div className="flex items-center gap-3 text-sm text-zinc-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {progress && `${progress.done} of ${progress.total}`}
                  <button className={button} onClick={() => (stop.current = true)}>
                    <Square className="h-3.5 w-3.5" /> Stop
                  </button>
                </div>
              ) : (
                <button className={button} disabled={!hasMap || !missing.length || Boolean(busy)} onClick={() => void lookUp()}>
                  <Tags className="h-4 w-4" /> Look up {missing.length} on MusicBrainz
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
};
