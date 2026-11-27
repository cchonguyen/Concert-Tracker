import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { genresApi, type GenresList, type LoggedEvent } from '../services/lineupApi';
import { parseCsv } from '../services/listImport';
import {
  parseGenreVocabCsv,
  type GenreTaxonomyPreview,
  type GenreVocabCsvPreview,
  type GenreVocabCsvRow,
} from '../server/events/genreVocabCsv';
import {
  parseGenreRelationsCsv,
  type GenreRelationsCsvPreview,
  type GenreRelationsCsvRow,
} from '../server/events/genreRelationsCsv';
import { genreResolver, NOT_GROUPED } from '../server/events/genreVocabulary';
import type { GenreCollision, GenreVocabChange } from '../server/events/genreTypes';
import { ArtistGenresPanel } from './ArtistGenresPanel';
import { GenreRecord } from './GenreRecord';
import { Button } from './ui/Button';
import { Equalizer } from './ui/Equalizer';
import { Ledger } from './ui/Ledger';
import { MenuButton, type MenuOption } from './ui/MenuButton';
import { Notice } from './ui/Notice';
import { Pill } from './ui/Pill';

// Manage > Global archive > Genres (docs/specs/genre-vocabulary.md section 6). Owner only:
// the Global archive is not shown to members. One row per genre after resolving, so
// spellings with the same key are one row. Counts are shared rows only; a member's own
// additions never count here (section 8). The search box lives in ManageView.

const field =
  'min-h-11 sm:min-h-9 rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const ALL = '__all';

export interface GenreListRow {
  key: string;
  name: string;
  group: string; // NOT_GROUPED when it has none
  aliases: string[]; // the owner's other spellings
  spellings: string[]; // every spelling seen with this genre's key or an alias of it
  umbrellas: string[]; // shown names of the genres this one sits under
  artists: number; // shared rows with this genre, after resolving
}

// Every vocabulary genre, every genre map style and every style on shared rows,
// resolved so each genre appears once.
function genreRows(data: GenresList): { rows: GenreListRow[]; groups: string[] } {
  const shared = data.genres.filter((r) => r.source !== 'added');
  const resolver = genreResolver(data.vocabulary, data.map, shared);
  const byKey = new Map<string, GenreListRow>();
  const artistsByKey = new Map<string, Set<string>>();
  const add = (style: string): string | undefined => {
    const r = resolver.resolve(style);
    if (!r.key) return undefined;
    let row = byKey.get(r.key);
    if (!row) {
      row = { key: r.key, name: r.name, group: r.parent ?? NOT_GROUPED, aliases: [], spellings: [], umbrellas: [], artists: 0 };
      byKey.set(r.key, row);
    }
    const s = style.trim();
    if (s && !row.spellings.includes(s)) row.spellings.push(s);
    return r.key;
  };
  for (const g of data.vocabulary.genres) add(g.name);
  for (const m of data.map) add(m.style);
  for (const r of shared) {
    for (const s of r.genres) {
      const k = add(s.style);
      if (!k) continue;
      let set = artistsByKey.get(k);
      if (!set) artistsByKey.set(k, (set = new Set()));
      set.add(r.key);
    }
  }
  for (const g of data.vocabulary.genres) {
    const row = byKey.get(g.key);
    if (!row) continue;
    row.aliases = g.aliases.map((a) => a.alias);
    row.umbrellas = g.umbrellas.map((u) => byKey.get(u)?.name ?? resolver.resolve(u).name);
  }
  for (const [k, set] of artistsByKey) {
    const row = byKey.get(k);
    if (row) row.artists = set.size;
  }
  const rows = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  const groups = [...new Set([...resolver.groups, ...rows.map((r) => r.group).filter((g) => g !== NOT_GROUPED)])].sort((a, b) =>
    a.localeCompare(b),
  );
  return { rows, groups };
}

const CollisionItem: React.FC<{ c: GenreCollision; busy: boolean; onPick: (key: string, spelling: string) => void }> = ({ c, busy, onPick }) => (
  <Ledger.Row edge="needs" className="flex-col items-stretch gap-2 p-3">
    <p className="text-sm text-text">
      Shown today as <span className="font-medium">{c.shown}</span>
    </p>
    <ul className="space-y-1">
      {c.spellings.map((s) => (
        <li key={s.name} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-text">
            {s.name}{' '}
            <span className="font-mono text-xs tabular-nums text-text-muted">
              {s.artists} {s.artists === 1 ? 'artist' : 'artists'}
            </span>
          </span>
          <Button onClick={() => onPick(c.key, s.name)} disabled={busy}>
            Use this spelling
          </Button>
        </li>
      ))}
    </ul>
  </Ledger.Row>
);

// The tree upload's preview, in plain words.
const TaxonomyPreviewLines: React.FC<{ preview: GenreTaxonomyPreview }> = ({ preview }) => {
  const { macros, families, genres, withoutFamily } = preview;
  const macroTotal = macros.created + macros.updated + macros.unchanged;
  const familyTotal = families.created + families.updated + families.unchanged;
  const genreTotal = genres.created + genres.updated + genres.unchanged;
  const hidden = withoutFamily.count - withoutFamily.names.length;
  return (
    <div className="space-y-1 text-sm text-text">
      <p>
        {macroTotal} macro genres, {familyTotal} families, {genreTotal} genres: {genres.created} new, {genres.updated} updated
      </p>
      <p className="text-xs text-text-muted">
        Macros: {macros.created} new, {macros.updated} updated · Families: {families.created} new, {families.updated} updated · Moved
        to another family: {genres.familyMoved} · Tier changed: {genres.tierChanged} · Spellings added: {preview.aliasesAdded} ·
        Spellings skipped (same as the genre&apos;s name): {preview.aliasesSkipped} · Secondary families added:{' '}
        {preview.secondaryAdded}, removed: {preview.secondaryRemoved}
      </p>
      {withoutFamily.count > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          <span>
            {withoutFamily.count} {withoutFamily.count === 1 ? 'genre has' : 'genres have'} no family after this upload
            {withoutFamily.checked === 'vocabulary only' ? ' (checked against the vocabulary only)' : ''}:
          </span>
          {withoutFamily.names.map((n) => (
            <Pill key={n} tone="neutral">
              {n}
            </Pill>
          ))}
          {hidden > 0 && <span>+{hidden} more</span>}
        </div>
      )}
    </div>
  );
};

const RELATION_TYPE_WORDS: Record<string, string> = {
  secondary_parent: 'Secondary family',
  adjacent: 'Adjacent',
  derived_from: 'Derived from',
};
const RELATION_ORIGIN_WORDS: Record<string, string> = {
  curated: 'set by you',
  artist_cooccur: 'from shared artists',
};

// The genre links upload's preview, in plain words.
const RelationsPreviewLines: React.FC<{ preview: GenreRelationsCsvPreview }> = ({ preview }) => (
  <div className="space-y-1 text-sm text-text">
    <p>
      {preview.added} added · {preview.removed} removed · {preview.weightChanged} weight changed · {preview.unchanged} unchanged
      {' '}across {preview.genresTouched} {preview.genresTouched === 1 ? 'genre' : 'genres'}
    </p>
    {preview.pairs.map((p) => (
      <p key={`${p.type}|${p.origin}`} className="text-xs text-text-muted">
        {RELATION_TYPE_WORDS[p.type] ?? p.type} ({RELATION_ORIGIN_WORDS[p.origin] ?? p.origin}): {p.added} added, {p.removed} removed,{' '}
        {p.weightChanged} weight changed, {p.unchanged} unchanged
      </p>
    ))}
  </div>
);

export const GenresPanel: React.FC<{ query: string; events: LoggedEvent[] }> = ({ query, events }) => {
  const [data, setData] = useState<GenresList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState<string>(ALL);
  const [showCollisions, setShowCollisions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState('');
  // The genre whose record is open, by key.
  const [selected, setSelected] = useState<string | null>(null);
  // The last change and its Undo.
  const [notice, setNotice] = useState<{ text: string; undoId?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [csvRows, setCsvRows] = useState<GenreVocabCsvRow[] | null>(null);
  const [csvPreview, setCsvPreview] = useState<GenreVocabCsvPreview | null>(null);
  const relFileRef = useRef<HTMLInputElement>(null);
  const [relRows, setRelRows] = useState<GenreRelationsCsvRow[] | null>(null);
  const [relPreview, setRelPreview] = useState<GenreRelationsCsvPreview | null>(null);
  const [artistGenresOpen, setArtistGenresOpen] = useState(false);

  const load = useCallback(
    () =>
      genresApi
        .list()
        .then((r) => {
          setData(r);
          setError(null);
        })
        .catch((err) => setError(messageOf(err))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const { rows, groups } = useMemo(() => (data ? genreRows(data) : { rows: [], groups: [] }), [data]);
  const collisions = data?.collisions ?? [];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (group !== ALL && r.group !== group) return false;
      if (!q) return true;
      return [r.name, ...r.aliases, ...r.spellings].some((n) => n.toLowerCase().includes(q));
    });
  }, [rows, query, group]);

  const groupOptions: MenuOption<string>[] = useMemo(
    () => [
      { value: ALL, label: 'All groups' },
      ...groups.map((g) => ({ value: g, label: g })),
      { value: NOT_GROUPED, label: NOT_GROUPED },
    ],
    [groups],
  );

  const run = async (action: () => Promise<GenreVocabChange>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const change = await action();
      setNotice({ text: change.summary, undoId: change.id });
      await load();
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // A change saved in the open genre's record: its notice with Undo, the list again,
  // and the genre it now lives under (after a rename or a merge).
  const changed = async (change: GenreVocabChange, selectKey?: string) => {
    setError(null);
    setNotice({ text: change.summary, undoId: change.id });
    await load();
    if (selectKey) setSelected(selectKey);
  };

  const undo = async () => {
    if (!notice?.undoId) return;
    const id = notice.undoId;
    setBusy(true);
    setError(null);
    try {
      await genresApi.undoVocabulary(id);
      setNotice({ text: 'Undone.' });
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const onCsvFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setCsvPreview(null);
    setCsvRows(null);
    try {
      const parsed = parseGenreVocabCsv(parseCsv(await file.text()));
      if (parsed.errors.length > 0) {
        setError(parsed.errors[0]);
        return;
      }
      setBusy(true);
      const preview = await genresApi.vocabCsvPreview(parsed.rows);
      setCsvRows(parsed.rows);
      setCsvPreview(preview);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const applyCsv = async () => {
    if (!csvRows) return;
    setBusy(true);
    setError(null);
    try {
      const res = await genresApi.vocabCsvApply(csvRows);
      setCsvRows(null);
      setCsvPreview(null);
      setNotice({
        text: res.change ? res.change.summary : 'No vocabulary changes to apply.',
        undoId: res.change?.id,
      });
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const onRelationsFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setRelPreview(null);
    setRelRows(null);
    try {
      const parsed = parseGenreRelationsCsv(parseCsv(await file.text()));
      if (parsed.errors.length > 0) {
        setError(parsed.errors[0]);
        return;
      }
      setBusy(true);
      const preview = await genresApi.relationsCsvPreview(parsed.rows);
      setRelRows(parsed.rows);
      setRelPreview(preview);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const applyRelations = async () => {
    if (!relRows) return;
    setBusy(true);
    setError(null);
    try {
      const res = await genresApi.relationsCsvApply(relRows);
      setRelRows(null);
      setRelPreview(null);
      setNotice({
        text: res.change ? res.change.summary : 'No genre link changes to apply.',
        undoId: res.change?.id,
      });
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const selectedRow = selected ? rows.find((r) => r.key === selected) : undefined;

  return (
    <section className="space-y-3">
      {error && <Notice tone="warning">{error}</Notice>}
      {notice && (
        <div className="flex flex-wrap items-center gap-2">
          <Notice tone="success">{notice.text}</Notice>
          {notice.undoId && (
            <Button variant="ghost" onClick={() => void undo()} disabled={busy}>
              Undo
            </Button>
          )}
        </div>
      )}

      {collisions.length > 0 && (
        <div className="space-y-2">
          <Notice tone="info">
            <span>
              {collisions.length} {collisions.length === 1 ? 'genre has' : 'genres have'} more than one spelling. Pick one.
            </span>{' '}
            <button
              type="button"
              onClick={() => setShowCollisions((v) => !v)}
              aria-expanded={showCollisions}
              className="text-accent hover:underline"
            >
              {showCollisions ? 'Hide' : 'Show'}
            </button>
          </Notice>
          {showCollisions && (
            <Ledger>
              {collisions.map((c) => (
                <CollisionItem key={c.key} c={c} busy={busy} onPick={(key, spelling) => void run(() => genresApi.pickGenreSpelling(key, spelling))} />
              ))}
            </Ledger>
          )}
        </div>
      )}

      {data && (
        <div className="flex flex-wrap items-center gap-2">
          <MenuButton label="Genre group" value={group} options={groupOptions} onChange={setGroup} />
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              void onCsvFile(file);
            }}
          />
          <Button onClick={() => setArtistGenresOpen(true)} disabled={busy} className="ml-auto">
            Artist genres CSV
          </Button>
          <Button onClick={() => fileRef.current?.click()} disabled={busy}>
            Upload vocabulary CSV
          </Button>
          <input
            ref={relFileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              void onRelationsFile(file);
            }}
          />
          <Button onClick={() => relFileRef.current?.click()} disabled={busy}>
            Upload genre links CSV
          </Button>
          <Button onClick={() => setCreating((v) => !v)} disabled={busy}>
            New genre
          </Button>
        </div>
      )}

      {artistGenresOpen && (
        <ArtistGenresPanel
          events={events}
          onClose={() => {
            setArtistGenresOpen(false);
            void load();
          }}
        />
      )}

      {csvPreview && csvRows && (
        <div className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
          {csvPreview.taxonomy ? (
            <TaxonomyPreviewLines preview={csvPreview.taxonomy} />
          ) : (
            <p className="text-sm text-text">
              Created {csvPreview.created} · Updated {csvPreview.updated} · Unchanged {csvPreview.unchanged} · Aliases added{' '}
              {csvPreview.aliasesAdded} · Umbrellas added {csvPreview.umbrellasAdded}
            </p>
          )}
          {csvPreview.skippedAliases.length > 0 && (
            <p className="text-xs text-text-muted">
              Skipped {csvPreview.skippedAliases.length} colliding {csvPreview.skippedAliases.length === 1 ? 'alias' : 'aliases'}:{' '}
              {csvPreview.skippedAliases
                .slice(0, 5)
                .map((s) => `${s.alias} (${s.reason.toLowerCase()})`)
                .join(', ')}
              {csvPreview.skippedAliases.length > 5 ? ` +${csvPreview.skippedAliases.length - 5} more` : ''}
            </p>
          )}
          {csvPreview.errors.length > 0 && <Notice tone="warning">{csvPreview.errors[0]}</Notice>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || csvPreview.errors.length > 0 || (csvPreview.created === 0 && csvPreview.updated === 0)}
              onClick={() => void applyCsv()}
            >
              Apply vocabulary
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setCsvRows(null);
                setCsvPreview(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {relPreview && relRows && (
        <div className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
          <RelationsPreviewLines preview={relPreview} />
          {relPreview.errors.length > 0 && <Notice tone="warning">{relPreview.errors[0]}</Notice>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || relPreview.errors.length > 0 || relPreview.added + relPreview.removed + relPreview.weightChanged === 0}
              onClick={() => void applyRelations()}
            >
              Apply genre links
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setRelRows(null);
                setRelPreview(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {creating && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface-1 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => genresApi.createGenre(newName.trim(), newGroup || null)).then((ok) => {
              if (!ok) return;
              setCreating(false);
              setNewName('');
              setNewGroup('');
            });
          }}
        >
          <input
            aria-label="New genre name"
            className={field}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Genre name"
            maxLength={80}
          />
          <select aria-label="Group for the new genre" className={field} value={newGroup} onChange={(e) => setNewGroup(e.target.value)}>
            <option value="">{NOT_GROUPED}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <Button variant="primary" type="submit" disabled={busy || !newName.trim()}>
            Add genre
          </Button>
          <Button onClick={() => setCreating(false)}>Cancel</Button>
        </form>
      )}

      {selectedRow && data && !visible.some((r) => r.key === selectedRow.key) && (
        <GenreRecord
          row={selectedRow}
          rows={rows}
          groups={groups}
          data={data}
          onChanged={changed}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}

      {data === null && !error && (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <Equalizer />
          <span>Loading genres…</span>
        </p>
      )}
      {data && rows.length === 0 && <p className="text-sm text-text-muted">No genres yet. They appear once an artist has one.</p>}
      {data && rows.length > 0 && visible.length === 0 && <p className="text-sm text-text-muted">No genre matches.</p>}
      {visible.length > 0 && (
        <Ledger>
          {visible.map((r) => (
            <React.Fragment key={r.key}>
              <Ledger.Row
                edge="none"
                selected={selected === r.key}
                onOpen={() => setSelected((s) => (s === r.key ? null : r.key))}
                className="flex-col items-stretch gap-1 p-3"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-text">{r.name}</span>
                  <span className="font-mono text-xs tabular-nums text-text-muted">
                    {r.artists} {r.artists === 1 ? 'artist' : 'artists'}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={r.group === NOT_GROUPED ? 'neutral' : 'accent'}>{r.group}</Pill>
                  {r.umbrellas.map((u) => (
                    <Pill key={u} tone="info">
                      Under {u}
                    </Pill>
                  ))}
                </span>
                {r.aliases.length > 0 && <span className="text-xs text-text-faint">Also spelled {r.aliases.join(', ')}</span>}
              </Ledger.Row>
              {selected === r.key && data && (
                <div className="border-b border-line bg-surface-0 p-3">
                  <GenreRecord
                    row={r}
                    rows={rows}
                    groups={groups}
                    data={data}
                    onChanged={changed}
                    onSelect={setSelected}
                    onClose={() => setSelected(null)}
                  />
                </div>
              )}
            </React.Fragment>
          ))}
        </Ledger>
      )}
    </section>
  );
};
