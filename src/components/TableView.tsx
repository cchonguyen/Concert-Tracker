import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CalendarX2,
  CircleCheck,
  Download,
  Eye,
  FileUp,
  Heart,
  Layers,
  ListChecks,
  Mail,
  MapPin,
  Minus,
  Mic2,
  Plus,
  Sheet,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tags,
  Tent,
  X,
} from 'lucide-react';
import type { EmailImport, LineupFacts, LineupSummary, LoggedEvent } from '../services/lineupApi';
import { artistsOf, eventsToCsv, formatsOf, kindLabel, supportOf, whenLabel } from '../services/format';
import { downloadText } from '../services/download';
import {
  activeFilterCount,
  actsInOrder,
  cityOf,
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
import { ArtistGenresPanel } from './ArtistGenresPanel';
import { SeriesPanel } from './SeriesPanel';
import { EventTitle } from './EventTitle';
import { SET_LABELS, seenSlots, slotId } from '../server/events/seen';
import { ATTENDANCE_LABELS, attendanceOf, AttendanceState } from '../server/events/attendance';
import { CaptureBar } from './CaptureBar';

interface TableViewProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  imports: EmailImport[];
  onOpen: (id: string) => void;
  onImported: () => void;
  onChanged: (event: LoggedEvent) => void;
  onCaptured: (event: LoggedEvent) => void; // a line typed in the Table's Add box
}

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';

// Each "has" chip: its name, then what it reads when set to yes or no.
const HAS_LABELS: Record<HasField, [string, string, string]> = {
  seen: ['Acts seen?', 'Has acts seen', 'No acts seen'],
  rating: ['Rated?', 'Rated', 'Not rated'],
  price: ['Priced?', 'Has a price', 'No price'],
  companions: ['With someone?', 'Went with someone', 'No one listed'],
  lineup: ['Lineup confirmed?', 'Lineup confirmed', 'Lineup not confirmed'],
};

const NEEDS_LABELS = { date: 'A date', pick: 'A pick', review: 'Lineup review' } as const;

// One header per column; a column can sort by more than one key (Where sorts
// by venue or city).
const COLUMNS: Array<{ label: string; sorts?: Array<{ key: SortKey; label: string }>; className?: string }> = [
  { label: 'Date', sorts: [{ key: 'date', label: 'Date' }], className: 'w-36' },
  { label: 'Event', sorts: [{ key: 'name', label: 'Event' }], className: 'min-w-48' },
  { label: 'Format', className: 'min-w-32' },
  { label: 'Where', sorts: [{ key: 'venue', label: 'Venue' }, { key: 'city', label: 'City' }], className: 'min-w-44' },
  { label: 'Seen', sorts: [{ key: 'seen', label: 'Seen' }], className: 'min-w-56' },
  { label: 'With', className: 'min-w-32' },
  { label: 'Rating', sorts: [{ key: 'rating', label: 'Rating' }], className: 'w-28' },
  { label: 'Status', className: 'w-32' },
];

const NEEDS_ICONS = { date: CalendarX2, pick: ListChecks, review: Eye } as const;

const readQuery = () => filtersFromQuery(typeof window === 'undefined' ? '' : window.location.search);

// A filter as one small pill: it reads its own name until you pick a value,
// then shows the value, highlighted.
const Pick: React.FC<{
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}> = ({ name, value, onChange, options }) => (
  <select
    aria-label={name}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`field-sizing-content max-w-[14rem] cursor-pointer truncate rounded-full border py-1 pl-3 pr-2 text-xs focus:border-violet-500 focus:outline-none ${
      value ? 'border-violet-500/70 bg-violet-600/20 text-violet-100' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
    }`}
  >
    <option value="">{name}</option>
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

// A "has" filter as a chip that cycles: any, has it, doesn't have it.
const NEXT_HAS: Record<Has, Has> = { any: 'yes', yes: 'no', no: 'any' };
const HasChip: React.FC<{ field: HasField; value: Has; onChange: (v: Has) => void }> = ({ field, value, onChange }) => {
  const [name, yes, no] = HAS_LABELS[field];
  return (
    <button
      onClick={() => onChange(NEXT_HAS[value])}
      title="Tap to cycle: any, has it, doesn't"
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
        value === 'yes'
          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
          : value === 'no'
            ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
            : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {value === 'yes' ? <Check className="h-3 w-3" /> : value === 'no' ? <Minus className="h-3 w-3" /> : null}
      {value === 'yes' ? yes : value === 'no' ? no : name}
    </button>
  );
};

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

const FormatChip: React.FC<{ value: string }> = ({ value }) => (
  <span className="rounded-full bg-zinc-800/80 px-1.5 py-px text-[11px] text-zinc-300">{value}</span>
);

// Concert or Festival on top, then the formats you gave, one chip each.
const FormatCell: React.FC<{ kind: string; format?: string }> = ({ kind, format }) => {
  const formats = formatsOf(format);
  if (!kind && !formats.length) return dash;
  return (
    <div className="space-y-1">
      {kind && <KindBadge kind={kind} />}
      {formats.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {formats.map((f) => (
            <FormatChip key={f} value={f} />
          ))}
        </div>
      )}
    </div>
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

// Upcoming, waiting for you to say you went, or missed. Nothing for an
// event you went to.
const WentBadge: React.FC<{ state: AttendanceState }> = ({ state }) =>
  state === 'went' ? null : (
    <span
      title={state === 'confirm' ? "Over: open it to say whether you went. Not counted until then." : 'Not counted in Stats, Artists or the Map'}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        state === 'confirm'
          ? 'border-violet-500/40 bg-violet-600/15 text-violet-200'
          : state === 'upcoming'
            ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
            : 'border-zinc-700 text-zinc-500'
      }`}
    >
      {ATTENDANCE_LABELS[state]}
    </span>
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
// A B2B counts as one slot ("A b2b B"); DJ and live sets are tagged, and
// the solo set of an act also in a B2B is its own slot, tagged solo.
const Acts: React.FC<{ seen: LoggedEvent['seen']; muted?: boolean }> = ({ seen, muted }) => {
  const slots = seenSlots(actsInOrder(seen));
  const shown = slots.slice(0, 3);
  const tag = (set: 'dj' | 'live') => (
    <span className="ml-1 text-[10px] uppercase text-sky-300/80" title={SET_LABELS[set]}>
      {set === 'dj' ? 'DJ' : 'Live'}
    </span>
  );
  return (
    <span className={muted ? 'text-zinc-500' : 'text-zinc-200'}>
      {shown.map((slot, i) => {
        const set = new Set(slot.map((s) => s.set)).size === 1 ? slot[0].set : undefined;
        return (
          <React.Fragment key={slotId(slot)}>
            {i > 0 && ', '}
            {slot.some((s) => s.favourite) && <Heart className="mr-0.5 inline h-3 w-3 -translate-y-px fill-rose-400 text-rose-400" />}
            {slot.map((s, j) => (
              <React.Fragment key={s.key}>
                {j > 0 && <span className="text-[10px] uppercase text-violet-300/80"> b2b </span>}
                {s.role === 'headliner' ? (
                  <span className="font-semibold text-amber-100" title="Headliner">
                    {s.name}
                  </span>
                ) : (
                  s.name
                )}
                {s.asSolo && <span className="ml-1 text-[10px] uppercase text-violet-300/80">solo</span>}
                {!set && s.set && tag(s.set)}
              </React.Fragment>
            ))}
            {set && tag(set)}
          </React.Fragment>
        );
      })}
      {slots.length > 3 && <span className="text-zinc-500"> +{slots.length - 3}</span>}
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
export const TableView: React.FC<TableViewProps> = ({ events, lineups, editions, imports, onOpen, onImported, onChanged, onCaptured }) => {
  const [filling, setFilling] = useState(false);
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [filters, setFilters] = useState<TableFilters>(readQuery);
  const [importing, setImporting] = useState(false);
  const [genres, setGenres] = useState(false);
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
  const today = new Date().toISOString().slice(0, 10);
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
    <SheetSync notice={sheetsNotice} onClose={() => setSyncing(false)} />
  );
  const genresButton = (
    <button onClick={() => setGenres(true)} className="inline-flex items-center gap-1.5 hover:text-zinc-200">
      <Tags className="h-3.5 w-3.5" /> Genres
    </button>
  );
  const seriesButton = (
    <button onClick={() => setLinking(true)} className="inline-flex items-center gap-1.5 hover:text-zinc-200">
      <Layers className="h-3.5 w-3.5" /> Series
    </button>
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
      {genres && <ArtistGenresPanel events={events} onClose={() => setGenres(false)} />}
      {linking && (
        <SeriesPanel
          events={events}
          onChanged={onChanged}
          onShow={(series) => {
            setLinking(false);
            set({ series });
          }}
          onOpen={(id) => {
            setLinking(false);
            onOpen(id);
          }}
          onClose={() => setLinking(false)}
        />
      )}
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
          onClick={() => setAdding((a) => !a)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${
            adding ? 'border-violet-500 text-violet-200' : 'border-zinc-800 text-zinc-300 hover:text-zinc-100'
          }`}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
        <button
          onClick={() => setShowFilters((s) => !s)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${
            showFilters ? 'border-violet-500 text-violet-200' : 'border-zinc-800 text-zinc-300 hover:text-zinc-100'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> Filters{active ? ` (${active})` : ''}
        </button>
        {filters.series && (
          <button
            onClick={() => set({ series: '' })}
            className="inline-flex items-center gap-1 rounded-full border border-violet-500/50 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-950/40"
            aria-label={`Stop showing only ${filters.series}`}
          >
            <Layers className="h-3 w-3" /> {filters.series} <X className="h-3 w-3" />
          </button>
        )}
        {active > 0 && (
          <button
            onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort, desc: filters.desc })}
            className="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
          <CaptureBar compact onCaptured={onCaptured} />
        </div>
      )}

      {showFilters && (
        <div className="space-y-2.5 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pick
              name="From year"
              value={filters.yearFrom ? String(filters.yearFrom) : ''}
              onChange={(v) => set({ yearFrom: year(v) })}
              options={options.years.map((y) => ({ value: String(y), label: `From ${y}` }))}
            />
            <Pick
              name="To year"
              value={filters.yearTo ? String(filters.yearTo) : ''}
              onChange={(v) => set({ yearTo: year(v) })}
              options={options.years.map((y) => ({ value: String(y), label: `To ${y}` }))}
            />
            <Pick
              name="Type"
              value={filters.kind === 'any' ? '' : filters.kind}
              onChange={(v) => set({ kind: (v || 'any') as TableFilters['kind'] })}
              options={[
                { value: 'concert', label: 'Concerts' },
                { value: 'festival', label: 'Festivals' },
                { value: 'unknown', label: 'Type not known' },
              ]}
            />
            {options.formats.length > 0 && <Pick name="Format" value={filters.format} onChange={(v) => set({ format: v })} options={list(options.formats)} />}
            {options.series.length > 0 && <Pick name="Series" value={filters.series} onChange={(v) => set({ series: v })} options={list(options.series)} />}
            {options.artists.length > 0 && (
              <Pick name="Saw" value={filters.artist} onChange={(v) => set({ artist: v })} options={options.artists.map((a) => ({ value: a.key, label: a.name }))} />
            )}
            {options.companions.length > 0 && (
              <Pick name="Went with" value={filters.companion} onChange={(v) => set({ companion: v })} options={list(options.companions)} />
            )}
            <Pick name="Venue" value={filters.venue} onChange={(v) => set({ venue: v })} options={list(options.venues)} />
            <Pick name="City" value={filters.city} onChange={(v) => set({ city: v })} options={list(options.cities)} />
            {options.regions.length > 1 && <Pick name="State" value={filters.region} onChange={(v) => set({ region: v })} options={list(options.regions)} />}
            {options.countries.length > 1 && (
              <Pick name="Country" value={filters.country} onChange={(v) => set({ country: v })} options={list(options.countries)} />
            )}
            <Pick
              name="Rating"
              value={filters.minRating ? String(filters.minRating) : ''}
              onChange={(v) => set({ minRating: v ? Number(v) : undefined })}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 5 ? '5 stars' : `${n}+ stars` }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-900 pt-2.5">
            {HAS_FIELDS.map((field) => (
              <HasChip key={field} field={field} value={filters.has[field] ?? 'any'} onChange={(v) => setHas(field, v)} />
            ))}
            <Pick
              name="Needs"
              value={filters.needs === 'any' ? '' : filters.needs}
              onChange={(v) => set({ needs: (v || 'any') as TableFilters['needs'] })}
              options={Object.entries(NEEDS_LABELS).map(([value, l]) => ({ value, label: `Needs ${l.toLowerCase()}` }))}
            />
            <Pick
              name="Went"
              value={filters.went === 'any' ? '' : filters.went}
              onChange={(v) => set({ went: (v || 'any') as TableFilters['went'] })}
              options={[
                { value: 'went', label: 'Went' },
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'confirm', label: 'Did you go? (to confirm)' },
                { value: 'missed', label: "Didn't go" },
              ]}
            />
            <Pick
              name="Added from"
              value={filters.origin === 'any' ? '' : filters.origin}
              onChange={(v) => set({ origin: (v || 'any') as TableFilters['origin'] })}
              options={[
                { value: 'typed', label: 'Typed by you' },
                { value: 'email', label: 'From ticket emails' },
              ]}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <span>
          {summary.events} event{summary.events === 1 ? '' : 's'} you went to
          {rows.length < events.length && <span className="text-zinc-600"> ({rows.length} of {events.length} shown)</span>}
          {' · '}
          {summary.acts} act{summary.acts === 1 ? '' : 's'} seen · {summary.venues} venue{summary.venues === 1 ? '' : 's'}
          {summary.firstYear !== undefined &&
            ` · ${summary.firstYear === summary.lastYear ? summary.firstYear : `${summary.firstYear} to ${summary.lastYear}`}`}
          {summary.averageRating !== undefined && ` · rated ${summary.averageRating} on average (${summary.rated} rated)`}
          {summary.totalPrice !== undefined && ` · ${summary.totalPrice.toLocaleString()} spent (${summary.priced} priced)`}
          {summary.upcoming > 0 && (
            <button onClick={() => set({ went: 'upcoming' })} className="text-sky-300/90 hover:underline">
              {' · '}
              {summary.upcoming} upcoming
            </button>
          )}
          {summary.toConfirm > 0 && (
            <button onClick={() => set({ went: 'confirm' })} className="text-violet-300 hover:underline">
              {' · '}
              {summary.toConfirm} to confirm
            </button>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-nowrap">
          {fillButton}
          {seriesButton}
          {genresButton}
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
                          <span><EventTitle event={e} /></span>
                          <WentBadge state={attendanceOf(e, today)} />
                          {fromEmail(e) && (
                            <span title="Added from a ticket email">
                              <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                            </span>
                          )}
                        </div>
                        {e.series && (
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <button
                              onClick={(ev) => {
                                ev.stopPropagation();
                                set({ series: e.series! });
                              }}
                              title={`Show only ${e.series}`}
                              className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 px-1.5 text-[11px] text-violet-300/90 hover:bg-violet-950/40"
                            >
                              <Layers className="h-3 w-3" /> {e.series}
                            </button>
                          </div>
                        )}
                      </td>
                      <td className={cell}>
                        <FormatCell kind={kindLabel(e, editions[e.id])} format={e.format} />
                      </td>
                      <td className={cell}>
                        {e.venue || e.city ? (
                          <>
                            <div className="text-zinc-200">{e.venue ?? <span className="text-zinc-600">Venue not known</span>}</div>
                            {e.city && (
                              <div className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                                <MapPin className="h-3 w-3 shrink-0" /> {cityOf(e)}
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
                      <div className="truncate font-medium text-zinc-100"><EventTitle event={e} /></div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
                        <WentBadge state={attendanceOf(e, today)} />
                        <KindBadge kind={kindLabel(e, editions[e.id])} />
                        {formatsOf(e.format).map((f) => (
                          <FormatChip key={f} value={f} />
                        ))}
                        {(e.venue || e.city) && (
                          <span className="inline-flex min-w-0 items-center gap-1 truncate">
                            <MapPin className="h-3 w-3 shrink-0 text-zinc-500" />
                            {[e.venue, cityOf(e)].filter(Boolean).join(' · ')}
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
