import { Dialog } from './ui/Dialog';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, FileUp, RefreshCw, Square, Tags, Upload, Undo2, X } from 'lucide-react';
import { genresApi, LoggedEvent } from '../services/lineupApi';
import { GENRES_CSV_AI_PROMPT } from '../services/cleanupPrompts';
import { ArtistGenres, genresByArtist, missingGenreKeys } from '../services/genres';
import { MAX_MUSICBRAINZ_GENRES } from '../server/events/genreTypes';
import type { GenreChange, GenreCsvRow, SkippedRow } from '../server/events/genreCsv';
import { genresCsvFileName, readGenresCsvFile } from '../services/genresCsvFile';
import { downloadText } from '../services/download';
import { Equalizer } from './ui/Equalizer';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { Notice } from './ui/Notice';
import { GenresCsvPreview } from './GenresCsvPreview';

// "Genres" in the Table view (owner only; ManageView shows the button): import the file music-story
// exports, look up the acts it does not cover on MusicBrainz, and edit genres in a spreadsheet.
// See ARCHITECTURE.md ("Artist genres") and docs/specs/genres-csv.md.

interface ArtistGenresPanelProps {
  events: LoggedEvent[];
  onClose: () => void;
}

interface CsvPreview {
  rows: GenreCsvRow[];
  changes: GenreChange[];
  skipped: SkippedRow[];
}

export const ArtistGenresPanel: React.FC<ArtistGenresPanelProps> = ({ events, onClose }) => {
  const [rows, setRows] = useState<ArtistGenres[] | null>(null);
  const [hasMap, setHasMap] = useState(false);
  const [csvUndo, setCsvUndo] = useState<{ at: string; count: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [overwrite, setOverwrite] = useState<Set<string>>(() => new Set());
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const copyGenresPrompt = async () => {
    try {
      await navigator.clipboard.writeText(GENRES_CSV_AI_PROMPT);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      setError('Could not copy to clipboard.');
    }
  };
  const stop = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);

  const load = () =>
    genresApi
      .list()
      .then((r) => {
        setRows(r.genres);
        setHasMap(r.hasMap);
        setCsvUndo(r.csvUndo);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    void load();
  }, []);

  const seenKeys = useMemo(() => new Set(events.flatMap((e) => e.seen.map((s) => s.key))), [events]);
  const by = useMemo(() => genresByArtist(rows ?? []), [rows]);
  const known = [...seenKeys].filter((k) => by.get(k)?.genres.length);
  const fromFile = known.filter((k) => by.get(k)?.source === 'music-story').length;
  const fromYou = known.filter((k) => by.get(k)?.source === 'owner' || by.get(k)?.source === 'you').length;
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

  // Download: the server writes the file (artist, MusicBrainz ID, current genres, source, blank New genres, version stamp).
  const downloadCsv = async () => {
    setBusy('csv-download');
    setError(null);
    setMessage(null);
    try {
      downloadText(genresCsvFileName(), await genresApi.csvExport());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // Upload: read the edited file here, then ask the server to check it. Nothing is saved yet.
  const checkCsv = async (file: File) => {
    setBusy('csv-check');
    setError(null);
    setMessage(null);
    setPreview(null);
    setOverwrite(new Set());
    try {
      const read = await readGenresCsvFile(file);
      if (!read.ok) throw new Error(read.error);
      if (read.rows.length === 0) {
        setMessage('No row has a "New genres" entry, so there is nothing to check.');
        return;
      }
      const r = await genresApi.csvPreview(read.rows);
      setPreview({ rows: read.rows, changes: r.changes as GenreChange[], skipped: r.skipped });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (csvInput.current) csvInput.current.value = '';
    }
  };

  const toggleOverwrite = (key: string) =>
    setOverwrite((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const applyCsv = async () => {
    if (!preview) return;
    setBusy('csv-apply');
    setError(null);
    setMessage(null);
    try {
      const r = await genresApi.csvApply(preview.rows, [...overwrite]);
      setPreview(null);
      setOverwrite(new Set());
      setMessage(
        `Saved ${r.saved} ${r.saved === 1 ? 'act' : 'acts'}.${r.skipped.length ? ` ${r.skipped.length} ${r.skipped.length === 1 ? 'row was' : 'rows were'} left out.` : ''} You can undo this upload below.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const undoCsvUpload = async () => {
    setBusy('csv-undo');
    setError(null);
    setMessage(null);
    try {
      const r = await genresApi.csvUndo();
      setMessage(
        `Put back ${r.restored} ${r.restored === 1 ? 'act' : 'acts'}.${r.leftAlone.length ? ` Left as they are, because you changed them since the upload: ${r.leftAlone.join(', ')}.` : ''}`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
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
              cover. Acts neither one knows stay without a genre. Genres you set here are shown to everyone.
            </p>
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>

        {error && <Notice tone="warning">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}

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
              <Button variant="primary" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
                {busy === 'import' ? <Equalizer size="sm" /> : <FileUp className="h-4 w-4" />} Choose file
              </Button>
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
                  <Button variant="secondary" onClick={() => (stop.current = true)}>
                    <Square className="h-3.5 w-3.5" /> Stop
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {missing.length > 0 && (
                    <Button variant="secondary" disabled={!hasMap || Boolean(busy)} onClick={() => void lookUp(missing)}>
                      <Tags className="h-4 w-4" /> Look up {missing.length} on MusicBrainz
                    </Button>
                  )}
                  {noneKeys.length > 0 && (
                    <Button variant="secondary" disabled={!hasMap || Boolean(busy)} onClick={() => void lookUp(noneKeys)}>
                      <RefreshCw className="h-4 w-4" /> Retry MusicBrainz scan ({noneKeys.length})
                    </Button>
                  )}
                  {allMbKeys.length > noneKeys.length && (
                    <Button variant="secondary" disabled={!hasMap || Boolean(busy)} onClick={() => void lookUp(allMbKeys)}>
                      <RefreshCw className="h-4 w-4" /> Re-scan all ({allMbKeys.length})
                    </Button>
                  )}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-text">3. Edit in a spreadsheet (CSV)</h3>
              <p className="text-xs text-text-muted">
                Download the list, type genres in the New genres column (separate several with semicolons), then upload the file.
                Blank rows are left alone. You check the changes before anything is saved.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void downloadCsv()}>
                  {busy === 'csv-download' ? <Equalizer size="sm" /> : <Download className="h-4 w-4" />} Download artists and genres (CSV)
                </Button>
                <input
                  ref={csvInput}
                  aria-label="Edited artists and genres file"
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && void checkCsv(e.target.files[0])}
                />
                <Button variant="secondary" disabled={Boolean(busy)} onClick={() => csvInput.current?.click()}>
                  {busy === 'csv-check' ? <Equalizer size="sm" /> : <Upload className="h-4 w-4" />} Choose your edited file
                </Button>
                <Button variant="secondary" onClick={() => void copyGenresPrompt()}>
                  {copiedPrompt ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copiedPrompt ? 'Copied prompt' : 'Copy AI prompt'}
                </Button>
                {csvUndo && !preview && (
                  <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void undoCsvUpload()}>
                    {busy === 'csv-undo' ? <Equalizer size="sm" /> : <Undo2 className="h-4 w-4" />} Undo this upload
                  </Button>
                )}
              </div>
              {csvUndo && !preview && (
                <p className="text-xs text-text-muted">
                  Only the latest upload can be undone. Undo puts back the genres it changed, except acts you have changed since.
                </p>
              )}
              {preview && (
                <>
                  {error && <Notice tone="warning">{error}</Notice>}
                  <GenresCsvPreview
                    changes={preview.changes}
                    skipped={preview.skipped}
                    overwrite={overwrite}
                    onToggleOverwrite={toggleOverwrite}
                    busy={Boolean(busy)}
                    onApply={() => void applyCsv()}
                    onCancel={() => {
                      setPreview(null);
                      setOverwrite(new Set());
                    }}
                  />
                </>
              )}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
};
