import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, GenreCount, genreMix } from '../services/genres';
import { artistsBehind, GenrePeriod, GenreTarget, genreTree, periodEvents } from '../services/genreInsights';
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

const GenreColumn: React.FC<{
  heading: string;
  kind: 'group' | 'style' | 'umbrella';
  rows: GenreCount[];
  filtered: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  onOpenArtistsWithGenre: (filterValue: string) => void;
  headerExtra?: React.ReactNode;
  note?: string;
}> = ({
  heading,
  kind,
  rows,
  filtered,
  byArtist,
  vocabulary,
  expandedKey,
  onToggle,
  onOpenArtistsWithGenre,
  headerExtra,
  note,
}) => {
  const max = Math.max(1, ...rows.map((r) => r.sets));
  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">{heading}</h3>
          {headerExtra}
        </div>
        {note && <p className="text-xs text-text-muted">{note}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">None in this period.</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((r) => {
            const rowId = `${kind}:${r.name}`;
            const open = expandedKey === rowId;
            const target: GenreTarget = { kind, name: r.name };
            const behind = open ? artistsBehind(filtered, byArtist, vocabulary, target) : [];
            const top5 = behind.slice(0, 5);
            const filterVal =
              kind === 'group' ? `g:${r.name}` : kind === 'umbrella' ? `u:${genreKey(r.name)}` : `s:${genreKey(r.name)}`;
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
                  <div className="mt-1 space-y-2 rounded-control border border-line bg-surface-2 p-3">
                    <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                      The artists behind it
                    </p>
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
                              style={{ width: `${Math.min(100, (a.weightedSets / Math.max(0.01, r.sets)) * 100)}%` }}
                            />
                          </span>
                        </li>
                      ))}
                    </ol>
                    <button
                      type="button"
                      onClick={() => onOpenArtistsWithGenre(filterVal)}
                      className="inline-flex min-h-11 items-center text-xs font-medium text-accent hover:underline sm:min-h-9"
                    >
                      See all {behind.length} {r.name.toLowerCase()} {behind.length === 1 ? 'act' : 'acts'} in Artists
                    </button>
                  </div>
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
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const allTimeMix = useMemo(() => genreMix(events, byArtist, vocabulary), [events, byArtist, vocabulary]);
  const filtered = useMemo(() => periodEvents(events, period, today), [events, period, today]);
  const mix = useMemo(() => genreMix(filtered, byArtist, vocabulary), [filtered, byArtist, vocabulary]);
  const treeRoots = useMemo(() => genreTree(vocabulary, events, byArtist, today), [vocabulary, events, byArtist, today]);

  const toggle = (key: string) => setExpandedKey((cur) => (cur === key ? null : key));

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

  const styleRows = includeRelated && mix.umbrellas.length > 0 ? mix.umbrellas : mix.styles;
  const styleKind: 'style' | 'umbrella' = includeRelated && mix.umbrellas.length > 0 ? 'umbrella' : 'style';

  return (
    <section className="space-y-4 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-normal text-text">Genres you see live</h2>
          <p className="text-xs text-text-muted">
            Share of the sets you saw, from {mix.known} of {plural(mix.sets, 'set')}
            {mix.sets > mix.known &&
              `; ${mix.sets - mix.known === 1 ? 'the other one has' : `the other ${mix.sets - mix.known} have`} no genre yet`}
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
                  setExpandedKey(null);
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
                    setExpandedKey(null);
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
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          <GenreColumn
            heading="Genre"
            kind="group"
            rows={mix.parents}
            filtered={filtered}
            byArtist={byArtist}
            vocabulary={vocabulary}
            expandedKey={expandedKey}
            onToggle={toggle}
            onOpenArtistsWithGenre={onOpenArtistsWithGenre}
          />
          <GenreColumn
            heading="Style"
            kind={styleKind}
            rows={styleRows}
            filtered={filtered}
            byArtist={byArtist}
            vocabulary={vocabulary}
            expandedKey={expandedKey}
            onToggle={toggle}
            onOpenArtistsWithGenre={onOpenArtistsWithGenre}
            headerExtra={
              mix.umbrellas.length > 0 ? (
                <div className="w-full sm:w-auto">
                  <Switch
                    checked={includeRelated}
                    onChange={(next) => {
                      setExpandedKey(null);
                      setIncludeRelated(next);
                    }}
                    label="Include related genres"
                  />
                </div>
              ) : undefined
            }
            note={includeRelated && mix.umbrellas.length > 0 ? 'A set counts once under each umbrella it falls in.' : undefined}
          />
        </div>
      )}
    </section>
  );
};
