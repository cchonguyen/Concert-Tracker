import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, GenreCount, formatSets, genreMix } from '../services/genres';
import {
  ZOOM_MIN_SETS,
  ZoomRow,
  artistsBehind,
  genreZoom,
  GenrePeriod,
  GenreTarget,
  genreTree,
  periodEvents,
} from '../services/genreInsights';
import type { GenreVocabulary } from '../server/events/genreTypes';
import { genreKey } from '../server/events/genreVocabulary';
import { isModifiedClick } from '../services/manageNav';
import { GenreTree } from './GenreTree';
import { useIsOwner } from './MeContext';
import { Segmented } from './ui/Segmented';
import { Switch } from './ui/Switch';

interface GenresRankingProps {
  events: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  onOpenArtistsWithGenre: (filterValue: string) => void;
}

type ZoomLevel = 'macro' | 'family' | 'genre';

// Which artist target each level's rows map to (macro is the music-story group when there is no taxonomy).
const LEVEL_KIND: Record<ZoomLevel, GenreTarget['kind']> = { macro: 'group', family: 'family', genre: 'style' };

// Segment colours for the 100% bar; the first is the accent token.
export const SEGMENT_COLOURS = [
  'var(--accent, #e11d48)',
  '#38bdf8',
  '#34d399',
  '#f59e0b',
  '#a78bfa',
  '#f472b6',
  '#2dd4bf',
  '#fb923c',
];
const BAR_SEGMENTS = 8;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const setsLabel = (n: number): string => {
  const s = formatSets(n);
  return `${s} ${s === '1' ? 'set' : 'sets'}`;
};
const wholePercent = (share: number): number => Math.round(share * 100);

function formatShortDate(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', year: 'numeric' });
  }
  if (/^\d{4}-\d{2}$/.test(d)) {
    return new Date(`${d}-01T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', year: 'numeric' });
  }
  return d;
}

function eventYears(events: LoggedEvent[]): number[] {
  const ys = new Set<number>();
  for (const e of events) {
    const y = e.startDate ? Number(e.startDate.slice(0, 4)) : e.year;
    if (y) ys.add(y);
  }
  return [...ys].sort((a, b) => b - a);
}

const filterValueFor = (kind: GenreTarget['kind'], name: string): string =>
  kind === 'group'
    ? `g:${name}`
    : kind === 'family'
      ? `f:${name}`
      : kind === 'umbrella'
        ? `u:${genreKey(name)}`
        : `s:${genreKey(name)}`;

// The "artists behind it" panel, opened from a row's name.
const ArtistsBehind: React.FC<{
  target: GenreTarget;
  sets: number;
  filtered: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  onOpenArtistsWithGenre: (filterValue: string) => void;
}> = ({ target, sets, filtered, byArtist, vocabulary, onOpenArtistsWithGenre }) => {
  const behind = artistsBehind(filtered, byArtist, vocabulary, target);
  const top5 = behind.slice(0, 5);
  return (
    <div className="mt-1 space-y-2 rounded-control border border-line bg-surface-2 p-3">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">The artists behind it</p>
      {behind.length === 0 ? (
        <p className="text-xs text-text-muted">No acts listed.</p>
      ) : (
        <>
          <ol className="space-y-1.5">
            {top5.map((a) => (
              <li key={a.key} className="space-y-0.5 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-text">{a.name}</span>
                  <span className="shrink-0 font-mono tabular-nums text-text-muted">
                    {plural(a.sets, 'set')}
                    {a.lastSeen ? ` · ${formatShortDate(a.lastSeen)}` : ''}
                  </span>
                </div>
                <span className="block h-1 rounded-full bg-surface-3">
                  <span
                    className="block h-1 rounded-full bg-accent-fill"
                    style={{ width: `${Math.min(100, (a.weightedSets / Math.max(0.01, sets)) * 100)}%` }}
                  />
                </span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => onOpenArtistsWithGenre(filterValueFor(target.kind, target.name))}
            className="inline-flex min-h-11 items-center text-xs font-medium text-accent hover:underline sm:min-h-9"
          >
            See all {behind.length} {target.name.toLowerCase()} {behind.length === 1 ? 'act' : 'acts'} in Artists
          </button>
        </>
      )}
    </div>
  );
};

// The related-genres (umbrella) column, shown only when "Including related genres" is on.
const UmbrellaColumn: React.FC<{
  rows: GenreCount[];
  filtered: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  onOpenArtistsWithGenre: (filterValue: string) => void;
  note?: string;
}> = ({ rows, filtered, byArtist, vocabulary, expandedKey, onToggle, onOpenArtistsWithGenre, note }) => {
  const max = Math.max(1, ...rows.map((r) => r.sets));
  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Related genres</h3>
        {note && <p className="text-xs text-text-muted">{note}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">None in this period.</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((r) => {
            const rowId = `umbrella:${r.name}`;
            const open = expandedKey === rowId;
            return (
              <li key={rowId} className="rounded-control border border-transparent">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => onToggle(rowId)}
                  className="group block min-h-11 w-full space-y-1 rounded-control px-1.5 py-1 text-left hover:bg-surface-2 sm:min-h-9"
                >
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-text group-hover:text-accent">
                      {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />}
                      <span className="truncate">{r.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                      {Math.round(r.share * 100)}% · {plural(Math.round(r.sets), 'set')}
                    </span>
                  </span>
                  <span className="block h-1.5 rounded-full bg-surface-3">
                    <span
                      className="block h-1.5 rounded-full bg-accent-fill transition-all motion-reduce:transition-none"
                      style={{ width: `${Math.min(100, (r.sets / max) * 100)}%` }}
                    />
                  </span>
                </button>
                {open && (
                  <ArtistsBehind
                    target={{ kind: 'umbrella', name: r.name }}
                    sets={r.sets}
                    filtered={filtered}
                    byArtist={byArtist}
                    vocabulary={vocabulary}
                    onOpenArtistsWithGenre={onOpenArtistsWithGenre}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

export const GenresRanking: React.FC<GenresRankingProps> = ({
  events,
  byArtist,
  vocabulary,
  onOpenArtistsWithGenre,
}) => {
  const isOwner = useIsOwner();
  const today = new Date().toISOString().slice(0, 10);
  const currentYear = Number(today.slice(0, 4));
  const years = useMemo(() => eventYears(events), [events]);

  const [period, setPeriod] = useState<GenrePeriod>('all');
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');
  const [includeRelated, setIncludeRelated] = useState(false);
  const [level, setLevel] = useState<ZoomLevel>('family');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [openParents, setOpenParents] = useState<Set<string>>(() => new Set());

  const allTimeMix = useMemo(() => genreMix(events, byArtist, vocabulary), [events, byArtist, vocabulary]);
  const filtered = useMemo(() => periodEvents(events, period, today), [events, period, today]);
  const mix = useMemo(() => genreMix(filtered, byArtist, vocabulary), [filtered, byArtist, vocabulary]);
  const zoom = useMemo(() => genreZoom(filtered, byArtist, vocabulary), [filtered, byArtist, vocabulary]);
  const treeRoots = useMemo(() => genreTree(vocabulary, events, byArtist, today), [vocabulary, events, byArtist, today]);

  const toggle = (key: string) => setExpandedKey((cur) => (cur === key ? null : key));
  const toggleParent = (key: string) =>
    setOpenParents((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const resetOpen = () => {
    setExpandedKey(null);
    setOpenParents(new Set());
  };

  if (allTimeMix.known === 0) {
    return (
      <div className="space-y-3 rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-text-muted">
        <p>No genres yet. Genres appear once your acts have them.</p>
        {isOwner && (
          <a
            href="?view=manage&scope=archive&section=genres"
            onClick={(e) => {
              if (isModifiedClick(e)) return;
              e.preventDefault();
              window.history.pushState(null, '', '?view=manage&scope=archive&section=genres');
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
            className="inline-flex min-h-11 items-center font-medium text-accent hover:underline sm:min-h-9"
          >
            Open Manage, Genres
          </a>
        )}
      </div>
    );
  }

  const segmentedPeriod: 'all' | 'last12' | 'year' =
    period === 'all' ? 'all' : period === 'last12' ? 'last12' : 'year';
  const pickedOtherYear = typeof period === 'number' && period !== currentYear ? String(period) : '';

  // Without the taxonomy the zoom has one level only: the music-story groups, shown as Macro.
  const activeLevel: ZoomLevel = zoom.levels === 'groups' ? 'macro' : level;
  const rows: ZoomRow[] = activeLevel === 'macro' ? zoom.macros : activeLevel === 'family' ? zoom.families : zoom.genres;
  const rowKind = LEVEL_KIND[activeLevel];
  // Rows open to the next level down; genres have nothing below them.
  const childKind: GenreTarget['kind'] | null = activeLevel === 'macro' ? 'family' : activeLevel === 'family' ? 'style' : null;

  const barTotal = rows.reduce((sum, r) => sum + r.share, 0);
  const barSegments = rows.slice(0, BAR_SEGMENTS).map((r, i) => ({ key: r.key, name: r.name, share: r.share, colour: SEGMENT_COLOURS[i] }));
  if (rows.length > BAR_SEGMENTS) {
    barSegments.push({
      key: 'other',
      name: 'Other',
      share: rows.slice(BAR_SEGMENTS).reduce((sum, r) => sum + r.share, 0),
      colour: '',
    });
  }

  // A top-level row's dot uses its bar colour; rows past the bar's segments share the Other grey.
  const renderRow = (row: ZoomRow, kind: GenreTarget['kind'], below: GenreTarget['kind'] | null, index?: number) => {
    const rowId = `${kind}:${row.name}`;
    const artistsOpen = expandedKey === rowId;
    const hasChildren = below !== null && (row.children?.length ?? 0) > 0;
    const parentOpen = hasChildren && openParents.has(rowId);
    return (
      <li key={rowId} className="space-y-1">
        <div className="flex items-stretch gap-1">
          {hasChildren && (
            <button
              type="button"
              aria-expanded={parentOpen}
              aria-label={`${parentOpen ? 'Hide' : 'Show'} ${row.name} ${below === 'family' ? 'families' : 'genres'}`}
              onClick={() => toggleParent(rowId)}
              className="inline-flex min-h-11 w-8 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 sm:min-h-9"
            >
              {parentOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            type="button"
            aria-expanded={artistsOpen}
            onClick={() => toggle(rowId)}
            className="group flex min-h-11 min-w-0 flex-1 items-baseline justify-between gap-2 rounded-control px-1.5 py-1 text-left text-sm hover:bg-surface-2 sm:min-h-9"
          >
            <span className="flex min-w-0 items-center gap-2">
              {index !== undefined && (
                <span
                  aria-hidden="true"
                  className={`inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full ${index < BAR_SEGMENTS ? '' : 'bg-line-strong'}`}
                  style={index < BAR_SEGMENTS ? { backgroundColor: SEGMENT_COLOURS[index] } : undefined}
                />
              )}
              <span className="truncate font-medium text-text group-hover:text-accent">{row.name}</span>
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
              {wholePercent(row.share)}% · {setsLabel(row.sets)}
            </span>
          </button>
        </div>
        {artistsOpen && (
          <ArtistsBehind
            target={{ kind, name: row.name }}
            sets={row.sets}
            filtered={filtered}
            byArtist={byArtist}
            vocabulary={vocabulary}
            onOpenArtistsWithGenre={onOpenArtistsWithGenre}
          />
        )}
        {parentOpen && below && (
          <ol className="ml-6 space-y-1 border-l border-line pl-3">
            {(row.children ?? []).map((child) => renderRow(child, below, null))}
          </ol>
        )}
      </li>
    );
  };

  return (
    <section className="space-y-4 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="poster-head text-2xl text-text">Genres you see live</h2>
          <p className="text-xs text-text-muted">
            Share of the sets you saw, from {formatSets(mix.known)} of {setsLabel(mix.sets)}
            {mix.sets > mix.known &&
              `; ${formatSets(mix.sets - mix.known) === '1' ? 'the other one has' : `the other ${formatSets(mix.sets - mix.known)} have`} no genre yet`}
            .
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {treeRoots.length > 0 && (
            <Segmented
              label="Genres view"
              compact
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: 'list', label: 'List' },
                { value: 'tree', label: 'Tree' },
              ]}
            />
          )}
          {viewMode === 'list' && (
            <>
              <Segmented
                label="Time period"
                compact
                value={segmentedPeriod}
                onChange={(v) => {
                  resetOpen();
                  if (v === 'all') setPeriod('all');
                  else if (v === 'last12') setPeriod('last12');
                  else setPeriod(currentYear);
                }}
                options={[
                  { value: 'all', label: 'All time' },
                  { value: 'last12', label: 'Last 12 months' },
                  { value: 'year', label: String(currentYear) },
                ]}
              />
              {years.length > 0 && (
                <select
                  aria-label="Pick a year"
                  value={pickedOtherYear}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    resetOpen();
                    setPeriod(Number(e.target.value));
                  }}
                  className="min-h-11 rounded-control border border-line-strong bg-surface-1 px-2.5 text-xs text-text focus:border-accent focus:outline-none sm:min-h-9"
                >
                  <option value="">Pick a year</option>
                  {years.map((y) => (
                    <option key={y} value={String(y)}>
                      {y}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>
      </div>

      {viewMode === 'tree' && treeRoots.length > 0 ? (
        <GenreTree roots={treeRoots} onOpenArtistsWithGenre={onOpenArtistsWithGenre} />
      ) : !zoom.enough ? (
        <p className="text-sm text-text-muted">
          Genres show once you have {ZOOM_MIN_SETS} sets with a genre. You have {setsLabel(zoom.known)}.
        </p>
      ) : (
        <div className={includeRelated && mix.umbrellas.length > 0 ? 'grid gap-6 sm:grid-cols-2' : 'space-y-6'}>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {zoom.levels === 'taxonomy' && (
                <Segmented
                  label="Breakdown level"
                  compact
                  value={level}
                  onChange={(v) => {
                    resetOpen();
                    setLevel(v);
                  }}
                  options={[
                    { value: 'macro', label: 'Macro' },
                    { value: 'family', label: 'Family' },
                    { value: 'genre', label: 'Genre' },
                  ]}
                />
              )}
              {mix.umbrellas.length > 0 && (
                <div className="w-full sm:w-auto">
                  <Switch
                    checked={includeRelated}
                    onChange={(next) => {
                      resetOpen();
                      setIncludeRelated(next);
                    }}
                    label="Include related genres"
                  />
                </div>
              )}
            </div>

            {barTotal > 0 && (
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-3">
                {barSegments.map((seg) => (
                  <span
                    key={seg.key}
                    role="img"
                    aria-label={`${seg.name}, ${wholePercent(seg.share)}%`}
                    title={`${seg.name}, ${wholePercent(seg.share)}%`}
                    className={`block h-full ${seg.colour ? '' : 'bg-line-strong'} transition-all motion-reduce:transition-none`}
                    style={{
                      width: `${(seg.share / barTotal) * 100}%`,
                      backgroundColor: seg.colour || undefined,
                    }}
                  />
                ))}
              </div>
            )}

            {rows.length === 0 ? (
              <p className="text-xs text-text-muted">None in this period.</p>
            ) : (
              <ol className="space-y-2">{rows.map((r, i) => renderRow(r, rowKind, childKind, i))}</ol>
            )}

            {zoom.unknown > 0 && (
              <p className="text-xs text-text-muted">
                {formatSets(zoom.unknown)} {formatSets(zoom.unknown) === '1' ? 'set had' : 'sets had'} no genre and are not
                counted.
              </p>
            )}
          </div>

          {includeRelated && mix.umbrellas.length > 0 && (
            <UmbrellaColumn
              rows={mix.umbrellas}
              filtered={filtered}
              byArtist={byArtist}
              vocabulary={vocabulary}
              expandedKey={expandedKey}
              onToggle={toggle}
              onOpenArtistsWithGenre={onOpenArtistsWithGenre}
              note="A set counts once under each umbrella it falls in."
            />
          )}
        </div>
      )}
    </section>
  );
};
