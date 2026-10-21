import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download, FileUp, SlidersHorizontal, X } from 'lucide-react';
import type { EmailImport, LineupFacts, LineupSummary, LoggedEvent } from '../services/lineupApi';
import { artistsOf, downloadText, eventsToCsv, kindLabel, supportOf, whenLabel } from '../services/format';
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filterEvents,
  filterOptions,
  filtersFromQuery,
  filtersToQuery,
  Has,
  HasField,
  HAS_FIELDS,
  needsOf,
  SortKey,
  summarize,
  TableFilters,
} from '../services/table';
import { ListImport } from './ListImport';

interface TableViewProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  imports: EmailImport[];
  onOpen: (id: string) => void;
  onImported: () => void;
}

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const label = 'space-y-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500';

const HAS_LABELS: Record<HasField, string> = {
  seen: 'Has acts seen',
  rating: 'Has a rating',
  price: 'Has a price',
  companions: 'Has who you went with',
  lineup: 'Lineup confirmed',
};

const NEEDS_LABELS = { date: 'A date', pick: 'A pick', review: 'Lineup review' } as const;

const COLUMNS: Array<{ key: SortKey | null; label: string; className?: string }> = [
  { key: 'date', label: 'Date' },
  { key: 'name', label: 'Event' },
  { key: null, label: 'Type' },
  { key: 'venue', label: 'Venue' },
  { key: 'city', label: 'City' },
  { key: null, label: 'Artist' },
  { key: null, label: 'Supporting' },
  { key: 'seen', label: 'Seen', className: 'text-right' },
  { key: null, label: 'With' },
  { key: 'rating', label: 'Rating', className: 'text-right' },
  { key: 'price', label: 'Price', className: 'text-right' },
  { key: null, label: 'Needs' },
];

const readQuery = () => filtersFromQuery(typeof window === 'undefined' ? '' : window.location.search);

const Select: React.FC<{
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  anyLabel?: string;
}> = ({ name, value, onChange, options, anyLabel = 'Any' }) => (
  <label className={label}>
    <span>{name}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className={control}>
      <option value="">{anyLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </label>
);

const dash = <span className="text-zinc-700">–</span>;

// At most a few names in a cell; the full list is in the tooltip.
const names = (acts: LoggedEvent['seen']) =>
  acts.length > 3 ? `${acts.slice(0, 3).map((s) => s.name).join(', ')} +${acts.length - 3}` : acts.map((s) => s.name).join(', ');

// Every event as a row you can filter, sort and export. A row opens the usual
// event panel for editing; "Import a list" adds events from a CSV you kept.
export const TableView: React.FC<TableViewProps> = ({ events, lineups, editions, imports, onOpen, onImported }) => {
  const [filters, setFilters] = useState<TableFilters>(readQuery);
  const [importing, setImporting] = useState(false);
  const [showFilters, setShowFilters] = useState(() => activeFilterCount(readQuery()) > 0);

  useEffect(() => {
    const q = filtersToQuery(filters);
    const url = `${window.location.pathname}?view=table${q ? `&${q}` : ''}`;
    window.history.replaceState(null, '', url);
  }, [filters]);

  const options = useMemo(() => filterOptions(events), [events]);
  const rows = useMemo(() => filterEvents(events, filters, lineups, editions), [events, filters, lineups, editions]);
  const summary = useMemo(() => summarize(rows), [rows]);
  const active = activeFilterCount(filters);
  const set = (patch: Partial<TableFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const setHas = (field: HasField, v: Has) => setFilters((f) => ({ ...f, has: { ...f.has, [field]: v } }));
  const sortBy = (key: SortKey) =>
    setFilters((f) => ({ ...f, sort: key, desc: f.sort === key ? !f.desc : key === 'date' || key === 'seen' || key === 'rating' || key === 'price' }));
  const year = (s: string) => (s ? Number(s) : undefined);
  const list = (values: string[]) => values.map((v) => ({ value: v, label: v }));

  const importButton = (
    <button onClick={() => setImporting(true)} className="inline-flex items-center gap-1.5 hover:text-zinc-200">
      <FileUp className="h-3.5 w-3.5" /> Import a list
    </button>
  );
  const importPanel = importing && (
    <ListImport events={events} imports={imports} onDone={onImported} onClose={() => setImporting(false)} />
  );

  if (!events.length) {
    return (
      <div className="space-y-2 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
        <p>Nothing to show yet. Events you add appear here as rows.</p>
        <p className="text-xs text-zinc-400">{importButton}</p>
        {importPanel}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {importPanel}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search events, venues, acts, people, notes"
          className={`${control} min-w-0 flex-1 py-2`}
        />
        <button
          onClick={() => setShowFilters((s) => !s)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${
            showFilters ? 'border-violet-500 text-violet-200' : 'border-zinc-800 text-zinc-300 hover:text-zinc-100'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> Filters{active ? ` (${active})` : ''}
        </button>
        {active > 0 && (
          <button
            onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort, desc: filters.desc })}
            className="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3 sm:grid-cols-3 lg:grid-cols-4">
          <Select
            name="From year"
            value={filters.yearFrom ? String(filters.yearFrom) : ''}
            onChange={(v) => set({ yearFrom: year(v) })}
            options={options.years.map((y) => ({ value: String(y), label: String(y) }))}
          />
          <Select
            name="To year"
            value={filters.yearTo ? String(filters.yearTo) : ''}
            onChange={(v) => set({ yearTo: year(v) })}
            options={options.years.map((y) => ({ value: String(y), label: String(y) }))}
          />
          <Select name="Venue" value={filters.venue} onChange={(v) => set({ venue: v })} options={list(options.venues)} />
          <Select name="City" value={filters.city} onChange={(v) => set({ city: v })} options={list(options.cities)} />
          {options.countries.length > 1 && (
            <Select name="Country" value={filters.country} onChange={(v) => set({ country: v })} options={list(options.countries)} />
          )}
          {options.artists.length > 0 && (
            <Select
              name="Saw"
              value={filters.artist}
              onChange={(v) => set({ artist: v })}
              options={options.artists.map((a) => ({ value: a.key, label: a.name }))}
            />
          )}
          {options.companions.length > 0 && (
            <Select name="Went with" value={filters.companion} onChange={(v) => set({ companion: v })} options={list(options.companions)} />
          )}
          <Select
            name="Rating"
            value={filters.minRating ? String(filters.minRating) : ''}
            onChange={(v) => set({ minRating: v ? Number(v) : undefined })}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 5 ? '5' : `${n} or more` }))}
          />
          <Select
            name="Needs"
            value={filters.needs === 'any' ? '' : filters.needs}
            onChange={(v) => set({ needs: (v || 'any') as TableFilters['needs'] })}
            options={Object.entries(NEEDS_LABELS).map(([value, l]) => ({ value, label: l }))}
          />
          <Select
            name="Type"
            value={filters.kind === 'any' ? '' : filters.kind}
            onChange={(v) => set({ kind: (v || 'any') as TableFilters['kind'] })}
            options={[
              { value: 'concert', label: 'Concert' },
              { value: 'festival', label: 'Festival' },
              { value: 'unknown', label: 'Not known yet' },
            ]}
          />
          <Select
            name="Added from"
            value={filters.origin === 'any' ? '' : filters.origin}
            onChange={(v) => set({ origin: (v || 'any') as TableFilters['origin'] })}
            options={[
              { value: 'typed', label: 'Typed by you' },
              { value: 'email', label: 'Ticket email' },
            ]}
          />
          {HAS_FIELDS.map((field) => (
            <Select
              key={field}
              name={HAS_LABELS[field]}
              value={filters.has[field] && filters.has[field] !== 'any' ? filters.has[field]! : ''}
              onChange={(v) => setHas(field, (v || 'any') as Has)}
              options={[
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
              ]}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <span>
          {summary.events} event{summary.events === 1 ? '' : 's'}
          {summary.events < events.length && <span className="text-zinc-600"> of {events.length}</span>}
          {' · '}
          {summary.acts} act{summary.acts === 1 ? '' : 's'} seen · {summary.venues} venue{summary.venues === 1 ? '' : 's'}
          {summary.firstYear !== undefined &&
            ` · ${summary.firstYear === summary.lastYear ? summary.firstYear : `${summary.firstYear} to ${summary.lastYear}`}`}
          {summary.averageRating !== undefined && ` · rated ${summary.averageRating} on average (${summary.rated} rated)`}
          {summary.totalPrice !== undefined && ` · ${summary.totalPrice.toLocaleString()} spent (${summary.priced} priced)`}
        </span>
        <span className="flex items-center gap-4">
          {importButton}
          <button
          onClick={() => downloadText(`livearchive-${new Date().toISOString().slice(0, 10)}.csv`, eventsToCsv(rows, editions))}
          disabled={!rows.length}
          className="inline-flex items-center gap-1.5 hover:text-zinc-200 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" /> {rows.length < events.length ? 'Export these rows' : 'Export all'} as CSV
          </button>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No events match these filters.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-zinc-900 md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-900/60 text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.label} className={`whitespace-nowrap px-3 py-2 font-semibold ${c.className ?? ''}`}>
                      {c.key ? (
                        <button onClick={() => sortBy(c.key!)} className="inline-flex items-center gap-1 uppercase hover:text-zinc-200">
                          {c.label}
                          {filters.sort === c.key &&
                            (filters.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {rows.map((e) => {
                  const needs = needsOf(e, lineups[e.id]);
                  return (
                    <tr key={e.id} onClick={() => onOpen(e.id)} className="cursor-pointer hover:bg-zinc-900/60">
                      <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{whenLabel(e) ?? dash}</td>
                      <td className="px-3 py-2 font-medium text-zinc-100">{e.name}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{kindLabel(e, editions[e.id]) || dash}</td>
                      <td className="px-3 py-2 text-zinc-300">{e.venue ?? dash}</td>
                      <td className="px-3 py-2 text-zinc-300">{e.city ?? dash}</td>
                      <td className="px-3 py-2 text-zinc-300" title={artistsOf(e.seen).map((s) => s.name).join(', ')}>
                        {names(artistsOf(e.seen)) || dash}
                      </td>
                      <td className="px-3 py-2 text-zinc-300" title={supportOf(e.seen).map((s) => s.name).join(', ')}>
                        {names(supportOf(e.seen)) || dash}
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-300" title={e.seen.map((s) => s.name).join(', ')}>
                        {e.seen.length || dash}
                      </td>
                      <td className="px-3 py-2 text-zinc-300">{e.companions.join(', ') || dash}</td>
                      <td className="px-3 py-2 text-right text-zinc-300">{e.rating ?? dash}</td>
                      <td className="px-3 py-2 text-right text-zinc-300">{e.ticketPrice ?? dash}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-500">{needs ? NEEDS_LABELS[needs] : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900 md:hidden">
            {rows.map((e) => {
              const needs = needsOf(e, lineups[e.id]);
              return (
                <li key={e.id}>
                  <button onClick={() => onOpen(e.id)} className="w-full space-y-0.5 px-3 py-2.5 text-left hover:bg-zinc-900/60">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium text-zinc-100">{e.name}</span>
                      <span className="shrink-0 text-xs text-zinc-500">{whenLabel(e) ?? 'Date unknown'}</span>
                    </div>
                    <div className="truncate text-xs text-zinc-400">
                      {[kindLabel(e, editions[e.id]), e.venue, e.city].filter(Boolean).join(' · ')}
                      {e.seen.length > 0 && ` · ${e.seen.length} seen`}
                      {e.rating !== undefined && e.rating !== null && ` · ${e.rating}/5`}
                      {needs && <span className="text-zinc-500"> · needs {NEEDS_LABELS[needs].toLowerCase()}</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
};
