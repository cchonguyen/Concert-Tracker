import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CalendarX2,
  CircleCheck,
  Download,
  Eye,
  FileUp,
  Heart,
  ListChecks,
  Mail,
  MapPin,
  Mic2,
  Sheet,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tent,
  X,
} from 'lucide-react';
import type { EmailImport, LineupFacts, LineupSummary, LoggedEvent } from '../services/lineupApi';
import { artistsOf, downloadText, eventsToCsv, kindLabel, supportOf, whenLabel } from '../services/format';
import {
  activeFilterCount,
  actsInOrder,
  EMPTY_FILTERS,
  filterEvents,
  filterOptions,
  filtersFromQuery,
  filtersToQuery,
  fromEmail,
  Has,
  HasField,
  HAS_FIELDS,
  needsOf,
  SortKey,
  summarize,
  tableDate,
  TableFilters,
} from '../services/table';
import { ListImport } from './ListImport';
import { SheetSync } from './SheetSync';
import { FillGaps } from './FillGaps';

interface TableViewProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  imports: EmailImport[];
  onOpen: (id: string) => void;
  onImported: () => void;
  onChanged: (event: LoggedEvent) => void;
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

// One header per column; a column can sort by more than one key (Where sorts
// by venue or city).
const COLUMNS: Array<{ label: string; sorts?: Array<{ key: SortKey; label: string }>; className?: string }> = [
  { label: 'Date', sorts: [{ key: 'date', label: 'Date' }], className: 'w-36' },
  { label: 'Event', sorts: [{ key: 'name', label: 'Event' }], className: 'min-w-56' },
  { label: 'Where', sorts: [{ key: 'venue', label: 'Venue' }, { key: 'city', label: 'City' }], className: 'min-w-48' },
  { label: 'Seen', sorts: [{ key: 'seen', label: 'Seen' }], className: 'min-w-64' },
  { label: 'With', className: 'min-w-32' },
  { label: 'Rating', sorts: [{ key: 'rating', label: 'Rating' }], className: 'w-28' },
  { label: 'Price', sorts: [{ key: 'price', label: 'Price' }], className: 'w-20 text-right' },
  { label: 'Status', className: 'w-36' },
];

const NEEDS_ICONS = { date: CalendarX2, pick: ListChecks, review: Eye } as const;

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

// Day, month and year in fixed-width slots, so they line up down the column.
// A missing part leaves its slot empty and the note says so.
const DateCell: React.FC<{ e: LoggedEvent }> = ({ e }) => {
  const d = tableDate(e);
  if (!d) return <span className="text-xs italic text-zinc-600">No date yet</span>;
  return (
    <div title={whenLabel(e) ?? undefined}>
      <div className="flex items-baseline gap-1.5 font-medium tabular-nums text-zinc-200">
        <span className="w-5 text-right">{d.day ?? ''}</span>
        <span className="w-8">{d.month ?? ''}</span>
        <span className="text-zinc-400">{d.year}</span>
      </div>
      {d.note && <div className="mt-0.5 pl-[1.625rem] text-[11px] text-zinc-500">{d.note}</div>}
    </div>
  );
};

const KIND_STYLES = {
  Festival: { icon: Tent, className: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300' },
  Concert: { icon: Mic2, className: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
} as const;

const KindBadge: React.FC<{ kind: string }> = ({ kind }) => {
  const style = KIND_STYLES[kind as keyof typeof KIND_STYLES];
  if (!style) return null;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${style.className}`}>
      <Icon className="h-3 w-3" /> {kind}
    </span>
  );
};

const Stars: React.FC<{ rating?: number | null }> = ({ rating }) =>
  rating ? (
    <span className="inline-flex gap-px" title={`${rating} of 5`} aria-label={`${rating} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={`h-3.5 w-3.5 ${n <= rating ? 'fill-amber-400 text-amber-400' : 'text-zinc-800'}`} />
      ))}
    </span>
  ) : (
    dash
  );

const NeedsBadge: React.FC<{ needs: keyof typeof NEEDS_LABELS }> = ({ needs }) => {
  const Icon = NEEDS_ICONS[needs];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
      <Icon className="h-3 w-3" /> {NEEDS_LABELS[needs]}
    </span>
  );
};

// At most a few names in a cell; the full list is in the tooltip.
// Headliners come first, in bold, then your favourite set, with a heart.
const Acts: React.FC<{ seen: LoggedEvent['seen']; muted?: boolean }> = ({ seen, muted }) => {
  const acts = actsInOrder(seen);
  const shown = acts.slice(0, 3);
  return (
    <span className={muted ? 'text-zinc-500' : 'text-zinc-200'}>
      {shown.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && ', '}
          {s.favourite && <Heart className="mr-0.5 inline h-3 w-3 -translate-y-px fill-rose-400 text-rose-400" />}
          {s.role === 'headliner' ? (
            <span className="font-semibold text-amber-100" title="Headliner">
              {s.name}
            </span>
          ) : (
            s.name
          )}
        </React.Fragment>
      ))}
      {acts.length > 3 && <span className="text-zinc-500"> +{acts.length - 3}</span>}
    </span>
  );
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

const People: React.FC<{ names: string[] }> = ({ names }) =>
  names.length ? (
    <span className="flex items-center gap-2" title={names.join(', ')}>
      <span className="flex -space-x-1.5">
        {names.slice(0, 3).map((n) => (
          <span
            key={n}
            className="grid h-6 w-6 place-items-center rounded-full border border-zinc-950 bg-zinc-800 text-[10px] font-semibold text-zinc-300"
          >
            {initials(n)}
          </span>
        ))}
      </span>
      <span className="truncate text-xs text-zinc-400">
        {names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`}
      </span>
    </span>
  ) : (
    dash
  );

// Every event as a row you can filter, sort and export. A row opens the usual
// event panel for editing; "Import a list" adds events from a CSV you kept.
export const TableView: React.FC<TableViewProps> = ({ events, lineups, editions, imports, onOpen, onImported, onChanged }) => {
  const [filling, setFilling] = useState(false);
  const [filters, setFilters] = useState<TableFilters>(readQuery);
  const [importing, setImporting] = useState(false);
  // Back from Google's sign-in (?sheets=connected, or what went wrong).
  const [sheetsNotice] = useState(() => new URLSearchParams(window.location.search).get('sheets'));
  const [syncing, setSyncing] = useState(Boolean(sheetsNotice));
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
  const sheetButton = (
    <button onClick={() => setSyncing(true)} className="inline-flex items-center gap-1.5 hover:text-zinc-200">
      <Sheet className="h-3.5 w-3.5" /> Google Sheets
    </button>
  );
  const sheetPanel = syncing && (
    <SheetSync events={events} imports={imports} notice={sheetsNotice} onDone={onImported} onClose={() => setSyncing(false)} />
  );
  const fillButton = (
    <button onClick={() => setFilling(true)} className="inline-flex items-center gap-1.5 hover:text-zinc-200">
      <Sparkles className="h-3.5 w-3.5" /> Fill gaps
    </button>
  );

  if (!events.length) {
    return (
      <div className="space-y-2 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
        <p>Nothing to show yet. Events you add appear here as rows.</p>
        <p className="flex justify-center gap-4 text-xs text-zinc-400">
          {importButton}
          {sheetButton}
        </p>
        {importPanel}
        {sheetPanel}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {importPanel}
      {sheetPanel}
      {filling && (
        <FillGaps
          events={rows}
          all={events}
          lineups={lineups}
          editions={editions}
          onChanged={onChanged}
          onRefresh={onImported}
          onOpen={(id) => {
            setFilling(false);
            onOpen(id);
          }}
          onClose={() => setFilling(false)}
        />
      )}
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
          {options.formats.length > 0 && (
            <Select name="Format" value={filters.format} onChange={(v) => set({ format: v })} options={list(options.formats)} />
          )}
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
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-nowrap">
          {fillButton}
          {importButton}
          {sheetButton}
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
          <div className="hidden max-h-[calc(100vh-11rem)] overflow-auto rounded-xl border border-zinc-900 md:block">
            <table className="w-full border-separate border-spacing-0 text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.label}
                      className={`sticky top-0 z-10 whitespace-nowrap border-b border-zinc-800 bg-zinc-900/95 px-4 py-2.5 font-semibold backdrop-blur ${c.className ?? ''}`}
                    >
                      {c.sorts ? (
                        <span className="inline-flex items-center gap-2">
                          {c.sorts.map((s, i) => (
                            <React.Fragment key={s.key}>
                              {i > 0 && <span className="text-zinc-700">/</span>}
                              <button
                                onClick={() => sortBy(s.key)}
                                className={`inline-flex items-center gap-1 uppercase hover:text-zinc-200 ${filters.sort === s.key ? 'text-zinc-200' : ''}`}
                              >
                                {s.label}
                                {filters.sort === s.key &&
                                  (filters.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                              </button>
                            </React.Fragment>
                          ))}
                        </span>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const needs = needsOf(e, lineups[e.id]);
                  const artists = artistsOf(e.seen);
                  const support = supportOf(e.seen);
                  const cell = 'border-b border-zinc-900 px-4 py-3 align-top';
                  return (
                    <tr key={e.id} onClick={() => onOpen(e.id)} className="cursor-pointer transition-colors hover:bg-zinc-900/60">
                      <td className={`${cell} whitespace-nowrap`}>
                        <DateCell e={e} />
                      </td>
                      <td className={cell}>
                        <div className="flex items-start gap-1.5 font-medium text-zinc-100">
                          <span>{e.name}</span>
                          {fromEmail(e) && (
                            <span title="Added from a ticket email">
                              <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <KindBadge kind={kindLabel(e, editions[e.id])} />
                          {e.format && <span className="text-[11px] text-zinc-500">{e.format}</span>}
                        </div>
                      </td>
                      <td className={cell}>
                        {e.venue || e.city ? (
                          <>
                            <div className="text-zinc-200">{e.venue ?? <span className="text-zinc-600">Venue not known</span>}</div>
                            {e.city && (
                              <div className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                                <MapPin className="h-3 w-3 shrink-0" /> {e.city}
                              </div>
                            )}
                          </>
                        ) : (
                          dash
                        )}
                      </td>
                      <td className={cell} title={e.seen.map((s) => s.name).join(', ')}>
                        {e.seen.length ? (
                          <div className="flex items-start gap-2">
                            <span className="mt-px shrink-0 rounded-md bg-zinc-800 px-1.5 text-[11px] font-semibold tabular-nums text-zinc-300">
                              {e.seen.length}
                            </span>
                            <div className="space-y-0.5">
                              {artists.length > 0 && <Acts seen={artists} />}
                              {support.length > 0 && (
                                <div className="text-xs">
                                  <span className="text-zinc-600">with </span>
                                  <Acts seen={support} muted />
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (
                          dash
                        )}
                      </td>
                      <td className={cell}>
                        <People names={e.companions} />
                      </td>
                      <td className={cell}>
                        <Stars rating={e.rating} />
                      </td>
                      <td className={`${cell} text-right tabular-nums text-zinc-300`}>{e.ticketPrice ?? dash}</td>
                      <td className={cell}>
                        {needs ? (
                          <NeedsBadge needs={needs} />
                        ) : e.editionId ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400/80">
                            <CircleCheck className="h-3.5 w-3.5" /> Lineup confirmed
                          </span>
                        ) : null}
                      </td>
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
                  <button onClick={() => onOpen(e.id)} className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-zinc-900/60">
                    <div className="w-28 shrink-0">
                      <DateCell e={e} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="truncate font-medium text-zinc-100">{e.name}</div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
                        <KindBadge kind={kindLabel(e, editions[e.id])} />
                        {(e.venue || e.city) && (
                          <span className="inline-flex min-w-0 items-center gap-1 truncate">
                            <MapPin className="h-3 w-3 shrink-0 text-zinc-500" />
                            {[e.venue, e.city].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                        {e.seen.length > 0 && <span>{e.seen.length} seen</span>}
                        {e.rating ? <Stars rating={e.rating} /> : null}
                        {needs && <NeedsBadge needs={needs} />}
                      </div>
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
