import { Dialog } from './ui/Dialog';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, RefreshCw, Square, Tags, X } from 'lucide-react';
import { genresApi, LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, genresByArtist, missingGenreKeys } from '../services/genres';
import { MAX_MUSICBRAINZ_GENRES } from '../server/events/genreTypes';
import { Equalizer } from './ui/Equalizer';

// "Artist genres" in the Table view: import the file music-story exports from
// your listening history, then, if you ask, look up the acts it does not
// cover on MusicBrainz. See ARCHITECTURE.md ("Artist genres").

interface ArtistGenresPanelProps {
  events: LoggedEvent[];
  onClose: () => void;
}

const button =
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text-muted hover:text-text disabled:opacity-40';
const primary =
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40';

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
  const noneKeys = useMemo(
    () => [...seenKeys].filter((k) => by.get(k) && !by.get(k)!.genres.length && by.get(k)!.source === 'musicbrainz'),
    [seenKeys, by],
  );
  const allMbKeys = useMemo(
    () => [...seenKeys].filter((k) => by.get(k)?.source === 'musicbrainz'),
    [seenKeys, by],
  );
  const checkedNone = noneKeys.length;

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

  const lookUp = async (keysToLookup = missing) => {
    const keys = keysToLookup;
    if (!keys.length) return;
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
      await load();
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
            <h2 className="flex items-center gap-2 font-display text-xl font-normal text-text">
              <Tags className="h-4 w-4 text-accent" /> Artist genres
            </h2>
            <p className="text-xs text-text-muted">
              Genres for the acts you saw, from your music-story listening history first, then MusicBrainz for acts it does not
              cover. Acts neither one knows stay without a genre.
            </p>
          </div>
          <button onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-text-muted hover:text-text" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="rounded-card border border-bad/45 bg-bad/10 p-2 text-sm text-bad">{error}</p>}
        {message && <p className="rounded-card border border-good/45 bg-good/10 p-2 text-sm text-good">{message}</p>}

        {!rows ? (
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <Equalizer /> Loading
          </p>
        ) : (
          <>
            <section className="rounded-card border border-line bg-surface-1 p-4 text-sm">
              <p className="text-text">
                Genres known for <strong className="font-mono tabular-nums">{known.length}</strong> of the <span className="font-mono tabular-nums">{seenKeys.size}</span> acts you saw.
              </p>
              <p className="font-mono text-xs tabular-nums text-text-muted">
                {fromFile} from music-story, {known.length - fromFile - fromYou} from MusicBrainz{fromYou ? `, ${fromYou} set by you` : ''}
                {checkedNone ? `, ${checkedNone} looked up with none found` : ''}.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-text">1. Import from music-story</h3>
              <p className="text-xs text-text-muted">
                In music-story, after a build, run <code className="font-mono text-text">uv run python -m pipeline.artist_genre export</code>{' '}
                and pick the file it writes, <code className="font-mono text-text">build/artist_genres.json</code>. Importing again replaces
                the genres it gave before.
              </p>
              <input
                ref={fileInput}
                aria-label="Genres file to import"
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
              />
              <button className={primary} disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
                {busy === 'import' ? <Equalizer size="sm" /> : <FileUp className="h-4 w-4" />} Choose file
              </button>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-text">2. Look up the rest on MusicBrainz</h3>
              <p className="text-xs text-text-muted">
                {!hasMap
                  ? 'Import the music-story file first: its genre map is how MusicBrainz genres are read.'
                  : missing.length > 0
                    ? `${missing.length === 1 ? '1 act has' : `${missing.length} acts have`} no genre from music-story and ${missing.length === 1 ? 'has' : 'have'} not been looked up.${noneKeys.length > 0 ? ` (${noneKeys.length} previously looked up with none found)` : ''} Each takes a few seconds; only an exact, unambiguous name match is used, and its genres are read through music-story's genre map.`
                    : noneKeys.length > 0
                      ? `All acts have been checked. ${noneKeys.length === 1 ? '1 act was' : `${noneKeys.length} acts were`} looked up with no genre found. You can retry the MusicBrainz scan for ${noneKeys.length === 1 ? 'it' : 'them'}.`
                      : 'All acts have genres assigned.'}
              </p>
              {busy === 'musicbrainz' ? (
                <div className="flex items-center gap-3 font-mono text-sm tabular-nums text-text-muted">
                  <Equalizer />
                  {progress && `${progress.done} of ${progress.total}`}
                  <button className={button} onClick={() => (stop.current = true)}>
                    <Square className="h-3.5 w-3.5" /> Stop
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {missing.length > 0 && (
                    <button className={button} disabled={!hasMap || Boolean(busy)} onClick={() => void lookUp(missing)}>
                      <Tags className="h-4 w-4" /> Look up {missing.length} on MusicBrainz
                    </button>
                  )}
                  {noneKeys.length > 0 && (
                    <button className={button} disabled={!hasMap || Boolean(busy)} onClick={() => void lookUp(noneKeys)}>
                      <RefreshCw className="h-4 w-4" /> Retry MusicBrainz scan ({noneKeys.length})
                    </button>
                  )}
                  {allMbKeys.length > noneKeys.length && (
                    <button className={button} disabled={!hasMap || Boolean(busy)} onClick={() => void lookUp(allMbKeys)}>
                      <RefreshCw className="h-4 w-4" /> Re-scan all ({allMbKeys.length})
                    </button>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
};
