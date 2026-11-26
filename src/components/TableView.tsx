import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  Download,
  FileUp,
  Heart,
  Layers,
  Mail,
  MapPin,
  Sheet,
  Sparkles,
  Tags,
  X,
} from 'lucide-react';
import type { LineupFacts, LineupSummary, LoggedEvent } from '../services/lineupApi';
import { DateStack } from './ui/DateStack';
import { artistsOf, eventYear, formatsOf, kindLabel, whenLabel } from '../services/format';
import { exportCsv } from './DataActions';
import { tintHue } from '../services/eventTint';
import { useToast } from './ui/Toast';
import { BackToTop } from './ui/BackToTop';
import { MenuButton } from './ui/MenuButton';
import { Ledger, type LedgerEdge } from './ui/Ledger';
import { KindPill, type EventKind } from './ui/KindPill';
import { HintPill } from './ui/HintPill';
import { Stars } from './ui/Stars';
import { FilterButton, FilterPanel, FilterSelect, FilterToggle } from './ui/FilterControls';
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
  nextSort,
  SortChoice,
  SortKey,
  summarize,
  tableDate,
  TableFilters,
  todayLineIndex,
} from '../services/table';
import { useIsOwner } from './MeContext';
import { FillGaps } from './FillGaps';
import { ArtistGenresPanel } from './ArtistGenresPanel';
import { SeriesPanel } from './SeriesPanel';
import type { ManageTarget } from './ManageView';
import { EventTitle } from './EventTitle';
import { SET_LABELS, seenSlots, slotId } from '../server/events/seen';
import { ATTENDANCE_LABELS, attendanceOf, AttendanceState } from '../server/events/attendance';
import { PersonName } from './PersonName';
import { nameForms } from '../services/people';

interface TableViewProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  onOpen: (id: string) => void;
  onChanged: (event: LoggedEvent) => void;
  // Series live in the Manage tab; without it, the Series panel opens here.
  onManage?: (target: ManageTarget) => void;
  onImport: () => void; // the same Import as the Menu and Quick add
  onSheets: () => void; // the same Google Sheets as the Menu
  onRefresh: () => void; // reload events after a fill-in
  today?: string;
}

const control =
  'min-h-11 sm:min-h-9 w-full rounded-control border border-line-strong bg-surface-1 px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';

const WENT_FILTER_LABELS: Record<Exclude<TableFilters['went'], 'any'>, string> = {
  all: 'Everything',
  went: 'Went',
  upcoming: 'Upcoming',
  confirm: 'To confirm',
  missed: "Didn't go",
};

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
// by venue or city). Details does not sort: its parts are in the sort menu
// instead, with Rating and Price.
const COLUMNS: Array<{ label: string; sorts?: Array<{ key: SortKey; label: string }>; className?: string }> = [
  { label: 'Date', sorts: [{ key: 'date', label: 'Date' }], className: 'w-32' },
  { label: 'Event', sorts: [{ key: 'name', label: 'Event' }], className: 'w-[22%]' },
  { label: 'Where', sorts: [{ key: 'venue', label: 'Venue' }, { key: 'city', label: 'City' }], className: 'w-[18%]' },
  { label: 'Seen', sorts: [{ key: 'seen', label: 'Seen' }], className: 'w-[30%]' },
  { label: 'Details', className: 'w-[22%]' },
];

// The sort menu lists every key, so Rating and Price stay reachable with no column.
const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'date', label: 'Date' },
  { value: 'name', label: 'Event' },
  { value: 'venue', label: 'Venue' },
  { value: 'city', label: 'City' },
  { value: 'seen', label: 'Seen' },
  { value: 'rating', label: 'Rating' },
  { value: 'price', label: 'Price' },
];
// The arrow on the sorted key says which way it runs; picking it again flips it, then turns sorting off.
const sortLabel = (label: string, f: { sort: SortChoice; desc: boolean }, key: SortKey) =>
  f.sort === key ? `${label} ${f.desc ? '↓' : '↑'}` : label;



const readQuery = () => filtersFromQuery(typeof window === 'undefined' ? '' : window.location.search);

export function nextRowId(
  events: { id: string }[],
  currentId: string,
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): string | null {
  if (events.length === 0) return null;
  const index = events.findIndex((e) => e.id === currentId);
  if (index === -1) return null;
  switch (key) {
    case 'ArrowDown':
      return events[Math.min(events.length - 1, index + 1)].id;
    case 'ArrowUp':
      return events[Math.max(0, index - 1)].id;
    case 'Home':
      return events[0].id;
    case 'End':
      return events[events.length - 1].id;
  }
}

const dash = <span className="text-text-faint">–</span>;

// Day, month and year in mono tabular figures, with weekday or missing-part note underneath.
const DateCell: React.FC<{ e: LoggedEvent }> = ({ e }) => {
  const d = tableDate(e);
  if (!d) return <span className="font-mono text-xs italic text-text-muted">No date yet</span>;
  return (
    <div title={whenLabel(e) ?? undefined}>
      <div className="flex items-baseline gap-1.5 font-mono text-xs font-medium tabular-nums text-text">
        {d.day && <span className="w-5 text-right">{d.day}</span>}
        {d.month && <span className="w-7">{d.month}</span>}
        <span className="text-text-muted">{d.year}</span>
      </div>
      {d.note && <div className="mt-0.5 font-mono text-[11px] text-text-muted">{d.note}</div>}
    </div>
  );
};

const toEventKind = (kind: string): EventKind =>
  kind === 'Festival' ? 'festival' : kind === 'Concert' ? 'show' : 'unknown';

const FormatChip: React.FC<{ value: string }> = ({ value }) => (
  <span className="rounded-control bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-muted">{value}</span>
);

const DetailsCell: React.FC<{
  e: LoggedEvent;
  state: AttendanceState;
  needs: keyof typeof NEEDS_LABELS | null;
  confirmed: boolean;
}> = ({ e, state, needs, confirmed }) => {
  const formats = formatsOf(e.format);
  const hasPrice = e.ticketPrice !== undefined && e.ticketPrice !== null;
  const email = fromEmail(e);
  if (!e.rating && !hasPrice && !email && !needs && !confirmed && state === 'went' && formats.length === 0) return dash;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {e.rating ? <Stars value={e.rating} size="sm" /> : null}
      {hasPrice && (
        <span className="font-mono text-xs tabular-nums text-text-muted" title={`Ticket price: $${e.ticketPrice}`}>
          ${e.ticketPrice}
        </span>
      )}
      {email && (
        <span title="Added from a ticket email" aria-label="Added from a ticket email" className="inline-flex text-text-muted">
          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
      {needs && <HintPill tone="needs">{NEEDS_LABELS[needs]}</HintPill>}
      {state !== 'went' && (
        <HintPill tone={state === 'confirm' ? 'needs' : 'info'}>{ATTENDANCE_LABELS[state]}</HintPill>
      )}
      {confirmed && (
        <span title="Lineup confirmed" aria-label="Lineup confirmed" className="inline-flex text-good">
          <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
      {formats.map((f) => (
        <FormatChip key={f} value={f} />
      ))}
    </div>
  );
};

// At most a few names in a cell; the full list is in the tooltip.
// Headliners come first, in bold, then your favourite set, with a heart.
// A B2B counts as one slot ("A b2b B"); DJ and live sets are tagged, and
// the solo set of an act also in a B2B is its own slot, tagged solo.
const Acts: React.FC<{ seen: LoggedEvent['seen']; muted?: boolean }> = ({ seen, muted }) => {
  const slots = seenSlots(actsInOrder(seen));
  const shown = slots.slice(0, 3);
  const tag = (set: string) => {
    const isDj = set.toLowerCase() === 'dj' || set.toLowerCase() === 'dj set';
    const isLive = set.toLowerCase() === 'live' || set.toLowerCase() === 'live set';
    const label = isDj ? 'DJ' : isLive ? 'Live' : set;
    return (
      <span className={`ml-1 font-mono text-[10px] ${isDj || isLive ? 'uppercase' : ''} text-text-muted`} title={SET_LABELS[set] || set}>
        {label}
      </span>
    );
  };
  return (
    <span className={muted ? 'text-text-muted' : 'text-text'}>
      {shown.map((slot, i) => {
        const set = new Set(slot.map((s) => s.set)).size === 1 ? slot[0].set : undefined;
        return (
          <React.Fragment key={slotId(slot)}>
            {i > 0 && ', '}
            {slot.some((s) => s.favourite) && <Heart className="mr-0.5 inline h-3 w-3 -translate-y-px fill-bad text-bad" aria-hidden="true" />}
            {slot.map((s, j) => (
              <React.Fragment key={s.key}>
                {j > 0 && <span className="font-mono text-[10px] uppercase text-accent"> b2b </span>}
                {s.role === 'headliner' ? (
                  <span className="font-semibold text-text" title="Headliner">
                    {s.name}
                  </span>
                ) : (
                  s.name
                )}
                {s.asSolo && <span className="ml-1 font-mono text-[10px] uppercase text-accent">solo</span>}
                {!set && s.set && tag(s.set)}
              </React.Fragment>
            ))}
            {set && tag(set)}
          </React.Fragment>
        );
      })}
      {slots.length > 3 && <span className="font-mono text-xs text-text-muted"> +{slots.length - 3}</span>}
    </span>
  );
};

const TodayIndicator: React.FC = () => (
  <div className="flex items-center gap-2 border-y border-accent-tint-line bg-accent-tint px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-accent">
    <span className="h-px flex-1 bg-accent-tint-line" />
    Today
    <span className="h-px flex-1 bg-accent-tint-line" />
  </div>
);

// Every event as a row you can filter, sort and export. A row opens the usual
// event panel for editing; "Import a list" adds events from a CSV you kept.
export const TableView: React.FC<TableViewProps> = ({ events, lineups, editions, onOpen, onChanged, onManage, onImport, onSheets, onRefresh, today: todayProp }) => {
  const [filling, setFilling] = useState(false);
  const [linking, setLinking] = useState(false);
  const toast = useToast();
  const [filters, setFilters] = useState<TableFilters>(readQuery);
  const [genres, setGenres] = useState(false);
  const [showFilters, setShowFilters] = useState(() => activeFilterCount(readQuery()) > 0);

  useEffect(() => {
    const q = filtersToQuery(filters);
    const url = `${window.location.pathname}?view=table${q ? `&${q}` : ''}`;
    window.history.replaceState(null, '', url);
  }, [filters]);

  const options = useMemo(() => filterOptions(events), [events]);
  const rows = useMemo(() => filterEvents(events, filters, lineups, editions), [events, filters, lineups, editions]);
  const summary = useMemo(() => summarize(rows), [rows]);
  // Events you didn't go to that the other filters would show; hidden until you ask for them.
  const hiddenMissed = useMemo(
    () => (filters.went === 'any' ? filterEvents(events, { ...filters, went: 'missed' }, lineups, editions).length : 0),
    [events, filters, lineups, editions],
  );
  const shownOf = events.length - (filters.went === 'any' ? events.filter((e) => e.attendance === 'missed').length : 0);
  const today = todayProp ?? new Date().toISOString().slice(0, 10);
  const todayLine = useMemo(() => todayLineIndex(rows, filters, today), [rows, filters, today]);
  const active = activeFilterCount(filters);
  const set = (patch: Partial<TableFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const setHas = (field: HasField, v: Has) => setFilters((f) => ({ ...f, has: { ...f.has, [field]: v } }));
  // A column header and the sort menu both cycle: the usual direction, the other, then off.
  const sortBy = (key: SortKey) => setFilters((f) => ({ ...f, ...nextSort(f, key) }));
  const pickSort = (choice: SortChoice) => (choice === 'none' ? setFilters((f) => ({ ...f, sort: 'none' })) : sortBy(choice));
  const sortOptions: Array<{ value: SortChoice; label: string; hint?: string }> = [
    ...SORT_OPTIONS.map((o) => ({ value: o.value, label: sortLabel(o.label, filters, o.value) })),
    { value: 'none', label: 'Order added', hint: 'Sort by order added (newest first)' },
  ];
  const year = (s: string) => (s ? Number(s) : undefined);
  const list = (values: string[]) => values.map((v) => ({ value: v, label: v }));

  const activeChips: Array<{ key: string; label: string; icon?: React.ReactNode; onRemove: () => void }> = [];
  if (filters.q) activeChips.push({ key: 'q', label: `Search: ${filters.q}`, onRemove: () => set({ q: '' }) });
  if (filters.yearFrom !== undefined) activeChips.push({ key: 'yearFrom', label: `From ${filters.yearFrom}`, onRemove: () => set({ yearFrom: undefined }) });
  if (filters.yearTo !== undefined) activeChips.push({ key: 'yearTo', label: `To ${filters.yearTo}`, onRemove: () => set({ yearTo: undefined }) });
  if (filters.kind !== 'any') {
    const kindText = filters.kind === 'concert' ? 'Concerts' : filters.kind === 'festival' ? 'Festivals' : 'Type not known';
    activeChips.push({ key: 'kind', label: kindText, onRemove: () => set({ kind: 'any' }) });
  }
  if (filters.format) activeChips.push({ key: 'format', label: `Format: ${filters.format}`, onRemove: () => set({ format: '' }) });
  if (filters.series) {
    activeChips.push({
      key: 'series',
      label: filters.series,
      icon: <Layers className="h-3 w-3 shrink-0" aria-hidden="true" />,
      onRemove: () => set({ series: '' }),
    });
  }
  if (filters.artist) {
    const artistName = options.artists.find((a) => a.key === filters.artist)?.name ?? filters.artist;
    activeChips.push({ key: 'artist', label: `Saw: ${artistName}`, onRemove: () => set({ artist: '' }) });
  }
  if (filters.companion) activeChips.push({ key: 'companion', label: `With: ${filters.companion}`, onRemove: () => set({ companion: '' }) });
  if (filters.venue) activeChips.push({ key: 'venue', label: `Venue: ${filters.venue}`, onRemove: () => set({ venue: '' }) });
  if (filters.city) activeChips.push({ key: 'city', label: `City: ${filters.city}`, onRemove: () => set({ city: '' }) });
  if (filters.region) activeChips.push({ key: 'region', label: `State: ${filters.region}`, onRemove: () => set({ region: '' }) });
  if (filters.country) activeChips.push({ key: 'country', label: `Country: ${filters.country}`, onRemove: () => set({ country: '' }) });
  if (filters.minRating !== undefined) {
    activeChips.push({
      key: 'minRating',
      label: filters.minRating === 5 ? '5 stars' : `${filters.minRating}+ stars`,
      onRemove: () => set({ minRating: undefined }),
    });
  }
  for (const field of HAS_FIELDS) {
    const v = filters.has[field];
    if (v && v !== 'any') {
      activeChips.push({
        key: `has-${field}`,
        label: HAS_LABELS[field][v === 'yes' ? 1 : 2],
        onRemove: () => setHas(field, 'any'),
      });
    }
  }
  if (filters.needs !== 'any') {
    activeChips.push({
      key: 'needs',
      label: `Needs ${NEEDS_LABELS[filters.needs].toLowerCase()}`,
      onRemove: () => set({ needs: 'any' }),
    });
  }
  if (filters.went !== 'any') {
    activeChips.push({
      key: 'went',
      label: WENT_FILTER_LABELS[filters.went],
      onRemove: () => set({ went: 'any' }),
    });
  }
  if (filters.origin !== 'any') {
    activeChips.push({
      key: 'origin',
      label: filters.origin === 'typed' ? 'Typed by you' : 'From ticket emails',
      onRemove: () => set({ origin: 'any' }),
    });
  }

  const importButton = (
    <button onClick={onImport} className="inline-flex items-center gap-1.5 hover:text-text">
      <FileUp className="h-3.5 w-3.5" /> Import a list
    </button>
  );
  // Sheets and the music-story/MusicBrainz genre tools stay the owner's; members edit their own genres in SeenGenres.
  const owner = useIsOwner();
  const sheetButton = !owner ? null : (
    <button onClick={onSheets} className="inline-flex items-center gap-1.5 hover:text-text">
      <Sheet className="h-3.5 w-3.5" /> Google Sheets
    </button>
  );
  const genresButton = !owner ? null : (
    <button onClick={() => setGenres(true)} className="inline-flex items-center gap-1.5 hover:text-text">
      <Tags className="h-3.5 w-3.5" /> Genres
    </button>
  );
  const seriesButton = (
    <button
      onClick={() => (onManage ? onManage({ kind: 'series' }) : setLinking(true))}
      className="inline-flex items-center gap-1.5 hover:text-text"
      title={onManage ? 'Series are in the Manage tab' : undefined}
    >
      <Layers className="h-3.5 w-3.5" /> Series
    </button>
  );
  const fillButton = (
    <button onClick={() => setFilling(true)} className="inline-flex items-center gap-1.5 hover:text-text">
      <Sparkles className="h-3.5 w-3.5" /> Fill gaps
    </button>
  );

  if (!events.length) {
    return (
      <div className="space-y-2 rounded-card border border-dashed border-line-strong bg-surface-1 p-6 text-center text-sm text-text-muted">
        <p>Nothing to show yet. Events you add appear here as rows.</p>
        <p className="flex justify-center gap-4 text-xs text-text-muted">
          {importButton}
          {sheetButton}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
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
          onRefresh={onRefresh}
          onOpen={(id) => {
            setFilling(false);
            onOpen(id);
          }}
          onClose={() => setFilling(false)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search events, venues, acts, people, notes"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search events, venues, acts, people, notes"
          className={`${control} min-w-0 flex-1`}
        />
        <MenuButton
          label="Sort rows"
          value={filters.sort}
          options={sortOptions}
          onChange={pickSort}
          className="[&>button]:h-auto [&>button]:min-h-11 [&>button]:sm:min-h-9 [&>button]:rounded-control [&>button]:border-line-strong [&>button]:bg-surface-1 [&>button]:text-text [&>button]:hover:border-accent-tint-line [&>button]:focus-visible:outline-accent"
        />
        <div className="[&>button]:h-auto [&>button]:min-h-11 [&>button]:sm:min-h-9 [&>button]:rounded-control [&>button]:border-line-strong [&>button]:bg-surface-1 [&>button]:text-text [&>button]:hover:border-accent-tint-line">
          <FilterButton open={showFilters} count={active} onClick={() => setShowFilters((s) => !s)} />
        </div>
      </div>

      {(activeChips.length > 0 || rows.length < events.length) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex min-h-7 items-center rounded-control border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs tabular-nums text-text-muted">
            {rows.length} of {events.length}
          </span>
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onRemove}
              aria-label={`Remove filter ${chip.label}`}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-control border border-accent-tint-line bg-accent-tint px-2.5 py-1 text-xs text-accent hover:border-accent"
            >
              {chip.icon}
              <span>{chip.label}</span>
              <X className="h-3 w-3 shrink-0" aria-hidden="true" />
            </button>
          ))}
          {active > 0 && (
            <button
              type="button"
              onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort, desc: filters.desc })}
              className="inline-flex min-h-8 items-center gap-1 rounded-control px-2 py-1 text-xs text-text-muted hover:text-text"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear all
            </button>
          )}
        </div>
      )}

      {showFilters && (
        <FilterPanel>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterSelect
              name="From year"
              value={filters.yearFrom ? String(filters.yearFrom) : ''}
              onChange={(v) => set({ yearFrom: year(v) })}
              options={options.years.map((y) => ({ value: String(y), label: `From ${y}` }))}
            />
            <FilterSelect
              name="To year"
              value={filters.yearTo ? String(filters.yearTo) : ''}
              onChange={(v) => set({ yearTo: year(v) })}
              options={options.years.map((y) => ({ value: String(y), label: `To ${y}` }))}
            />
            <FilterSelect
              name="Type"
              value={filters.kind === 'any' ? '' : filters.kind}
              onChange={(v) => set({ kind: (v || 'any') as TableFilters['kind'] })}
              options={[
                { value: 'concert', label: 'Concerts' },
                { value: 'festival', label: 'Festivals' },
                { value: 'unknown', label: 'Type not known' },
              ]}
            />
            {options.formats.length > 0 && <FilterSelect name="Format" value={filters.format} onChange={(v) => set({ format: v })} options={list(options.formats)} />}
            {options.series.length > 0 && <FilterSelect name="Series" value={filters.series} onChange={(v) => set({ series: v })} options={list(options.series)} />}
            {options.artists.length > 0 && (
              <FilterSelect name="Saw" value={filters.artist} onChange={(v) => set({ artist: v })} options={options.artists.map((a) => ({ value: a.key, label: a.name }))} />
            )}
            {options.companions.length > 0 && (
              <FilterSelect name="Went with" value={filters.companion} onChange={(v) => set({ companion: v })} options={list(options.companions)} />
            )}
            <FilterSelect name="Venue" value={filters.venue} onChange={(v) => set({ venue: v })} options={list(options.venues)} />
            <FilterSelect name="City" value={filters.city} onChange={(v) => set({ city: v })} options={list(options.cities)} />
            {options.regions.length > 1 && <FilterSelect name="State" value={filters.region} onChange={(v) => set({ region: v })} options={list(options.regions)} />}
            {options.countries.length > 1 && (
              <FilterSelect name="Country" value={filters.country} onChange={(v) => set({ country: v })} options={list(options.countries)} />
            )}
            <FilterSelect
              name="Rating"
              value={filters.minRating ? String(filters.minRating) : ''}
              onChange={(v) => set({ minRating: v ? Number(v) : undefined })}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 5 ? '5 stars' : `${n}+ stars` }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-900 pt-2.5">
            {HAS_FIELDS.map((field) => {
              const [name, yes, no] = HAS_LABELS[field];
              return <FilterToggle key={field} name={name} yes={yes} no={no} value={filters.has[field] ?? 'any'} onChange={(v) => setHas(field, v)} />;
            })}
            <FilterSelect
              name="Needs"
              value={filters.needs === 'any' ? '' : filters.needs}
              onChange={(v) => set({ needs: (v || 'any') as TableFilters['needs'] })}
              options={Object.entries(NEEDS_LABELS).map(([value, l]) => ({ value, label: `Needs ${l.toLowerCase()}` }))}
            />
            <FilterSelect
              name="Went"
              value={filters.went === 'any' ? '' : filters.went}
              onChange={(v) => set({ went: (v || 'any') as TableFilters['went'] })}
              options={[
                { value: 'all', label: "Everything, with ones you didn't go to" },
                { value: 'went', label: 'Went' },
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'confirm', label: 'Did you go? (to confirm)' },
                { value: 'missed', label: "Didn't go" },
              ]}
            />
            <FilterSelect
              name="Added from"
              value={filters.origin === 'any' ? '' : filters.origin}
              onChange={(v) => set({ origin: (v || 'any') as TableFilters['origin'] })}
              options={[
                { value: 'typed', label: 'Typed by you' },
                { value: 'email', label: 'From ticket emails' },
              ]}
            />
          </div>
        </FilterPanel>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
        <span>
          <span className="font-mono tabular-nums text-text">{summary.events}</span> event{summary.events === 1 ? '' : 's'} you went to
          {rows.length < shownOf && (
            <span className="font-mono tabular-nums text-text-muted"> ({rows.length} of {shownOf} shown)</span>
          )}
          {' · '}
          <span className="font-mono tabular-nums">{summary.acts}</span> act{summary.acts === 1 ? '' : 's'} seen ·{' '}
          <span className="font-mono tabular-nums">{summary.venues}</span> venue{summary.venues === 1 ? '' : 's'}
          {summary.firstYear !== undefined &&
            ` · ${summary.firstYear === summary.lastYear ? summary.firstYear : `${summary.firstYear} to ${summary.lastYear}`}`}
          {summary.averageRating !== undefined && ` · rated ${summary.averageRating} on average (${summary.rated} rated)`}
          {summary.totalPrice !== undefined && ` · ${summary.totalPrice.toLocaleString()} spent (${summary.priced} priced)`}
          {summary.upcoming > 0 && (
            <button onClick={() => set({ went: 'upcoming' })} className="text-accent hover:underline">
              {' · '}
              {summary.upcoming} upcoming
            </button>
          )}
          {summary.toConfirm > 0 && (
            <button onClick={() => set({ went: 'confirm' })} className="text-accent hover:underline">
              {' · '}
              {summary.toConfirm} to confirm
            </button>
          )}
          {hiddenMissed > 0 && (
            <>
              {' · '}
              <span className="font-mono tabular-nums">{hiddenMissed}</span> you didn't go to hidden{' '}
              <button onClick={() => set({ went: 'all' })} className="text-accent hover:underline">
                Show them
              </button>
            </>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-nowrap [&>button]:min-h-11 sm:[&>button]:min-h-9">
          {fillButton}
          {seriesButton}
          {genresButton}
          {importButton}
          {sheetButton}
          <button
          onClick={() => {
            exportCsv(rows, editions);
            toast({ message: `Exported ${rows.length} ${rows.length === 1 ? 'show' : 'shows'} as CSV` });
          }}
          disabled={!rows.length}
          className="inline-flex items-center gap-1.5 hover:text-text disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" /> {rows.length < events.length ? 'Export these rows' : 'Export all'} as CSV
          </button>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong bg-surface-1 p-6 text-center text-sm text-text-muted">No events match these filters.</p>
      ) : (
        <>
          <div
            className="hidden max-h-[calc(100vh-11rem)] overflow-auto border border-line-strong bg-surface-1 md:block"
            onKeyDown={(k) => {
              if (k.key !== 'ArrowUp' && k.key !== 'ArrowDown' && k.key !== 'Home' && k.key !== 'End') return;
              const target = k.target;
              if (!(target instanceof HTMLElement) || target.tagName !== 'BUTTON') return;
              const currentId = target.getAttribute('data-event-id');
              if (!currentId) return;
              const nextId = nextRowId(rows, currentId, k.key);
              if (!nextId) return;
              k.preventDefault();
              const nextRow = k.currentTarget.querySelector<HTMLElement>(`button[data-event-id="${CSS.escape(nextId)}"]`);
              nextRow?.focus();
            }}
          >
            <div className="sticky top-0 z-10 grid grid-cols-[8rem_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.15fr)] gap-3 border-b border-line bg-surface-2 px-4 py-2.5 pl-[19px] font-mono text-[11px] uppercase tracking-wider text-text-faint">
              {COLUMNS.map((c) => (
                <div key={c.label} className="whitespace-nowrap">
                  {c.sorts ? (
                    <span className="inline-flex items-center gap-2">
                      {c.sorts.map((s, i) => {
                        const activeSort = filters.sort === s.key;
                        return (
                          <React.Fragment key={s.key}>
                            {i > 0 && <span aria-hidden="true" className="text-line-strong">/</span>}
                            <button
                              onClick={() => sortBy(s.key)}
                              title="Sorts by this column; press again to reverse it, and a third time to stop sorting."
                              className={`inline-flex items-center gap-1 font-mono uppercase tracking-wider hover:text-text ${activeSort ? 'font-semibold text-text' : 'text-text-faint'}`}
                            >
                              {s.label}
                              {activeSort &&
                                (filters.desc ? (
                                  <ArrowDown className="h-3 w-3 text-accent" aria-hidden="true" />
                                ) : (
                                  <ArrowUp className="h-3 w-3 text-accent" aria-hidden="true" />
                                ))}
                            </button>
                          </React.Fragment>
                        );
                      })}
                    </span>
                  ) : (
                    c.label
                  )}
                </div>
              ))}
            </div>
            <Ledger bare>
              {(() => {
                const showYears = filters.sort === 'date';
                const yearCounts = new Map<string, number>();
                if (showYears) {
                  for (const ev of rows) {
                    const yl = eventYear(ev) ? String(eventYear(ev)) : 'No date yet';
                    yearCounts.set(yl, (yearCounts.get(yl) ?? 0) + 1);
                  }
                }
                let prevYear: string | null = null;
                return rows.map((e, i) => {
                  const needs = needsOf(e, lineups[e.id]);
                  const state = attendanceOf(e, today);
                  const artists = artistsOf(e.seen);
                  const kind = kindLabel(e, editions[e.id]);
                  const eventKind = toEventKind(kind);
                  const edge: LedgerEdge = needs || state === 'confirm' ? 'needs' : eventKind === 'festival' ? 'festival' : eventKind === 'show' ? 'show' : 'none';
                  const yearLabel = eventYear(e) ? String(eventYear(e)) : 'No date yet';
                  const showSep = showYears && yearLabel !== prevYear;
                  prevYear = yearLabel;
                  return (
                    <React.Fragment key={e.id}>
                      {i === todayLine && <TodayIndicator />}
                      {showSep && <Ledger.Separator label={yearLabel} count={yearCounts.get(yearLabel)} />}
                      <Ledger.Row
                        edge={edge}
                        onOpen={() => onOpen(e.id)}
                        data-event-id={e.id}
                        className="grid grid-cols-[8rem_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.15fr)] items-start gap-3 px-4 py-3 text-sm"
                      >
                        <div className="whitespace-nowrap">
                          <DateCell e={e} />
                        </div>
                        <div className="min-w-0 space-y-1">
                          <div className="font-medium text-text">
                            <EventTitle event={e} />
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <KindPill kind={eventKind} size="sm" />
                            {e.series && (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  set({ series: e.series! });
                                }}
                                onKeyDown={(ev) => {
                                  if (ev.key === 'Enter' || ev.key === ' ') {
                                    ev.preventDefault();
                                    ev.stopPropagation();
                                    set({ series: e.series! });
                                  }
                                }}
                                title={`Show only ${e.series}`}
                                className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text"
                              >
                                <SeriesDot series={e.series!} />
                                {e.series}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="min-w-0">
                          {e.venue || e.city ? (
                            <>
                              <div className="text-text">{e.venue ?? <span className="text-text-muted">Venue not known</span>}</div>
                              {e.city && (
                                <div className="mt-0.5 flex items-center gap-1 text-xs text-text-muted">
                                  <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" /> {cityOf(e)}
                                </div>
                              )}
                            </>
                          ) : (
                            dash
                          )}
                        </div>
                        <div className="min-w-0" title={e.seen.map((s) => s.name).join(', ')}>
                          {e.seen.length ? (
                            <div className="flex items-start gap-2">
                              <span className="mt-px shrink-0 rounded-control bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-text-muted">
                                {e.seen.length}
                              </span>
                              <div className="min-w-0 space-y-0.5">{artists.length > 0 && <Acts seen={artists} />}</div>
                            </div>
                          ) : (
                            dash
                          )}
                        </div>
                        <div className="min-w-0">
                          <DetailsCell
                            e={e}
                            state={attendanceOf(e, today)}
                            needs={needs}
                            confirmed={Boolean(e.editionId)}
                          />
                        </div>
                      </Ledger.Row>
                    </React.Fragment>
                  );
                });
              })()}
              {todayLine === rows.length && todayLine > 0 && <TodayIndicator />}
            </Ledger>
          </div>

          <div className="md:hidden">
            <Ledger>
              {(() => {
                const showYears = filters.sort === 'date';
                const yearCounts = new Map<string, number>();
                if (showYears) {
                  for (const ev of rows) {
                    const yl = eventYear(ev) ? String(eventYear(ev)) : 'No date yet';
                    yearCounts.set(yl, (yearCounts.get(yl) ?? 0) + 1);
                  }
                }
                let prevYear: string | null = null;
                return rows.map((e, i) => {
                  const needs = needsOf(e, lineups[e.id]);
                  const state = attendanceOf(e, today);
                  const kind = kindLabel(e, editions[e.id]);
                  const eventKind = toEventKind(kind);
                  const edge: LedgerEdge = needs || state === 'confirm' ? 'needs' : eventKind === 'festival' ? 'festival' : eventKind === 'show' ? 'show' : 'none';
                  const yearLabel = eventYear(e) ? String(eventYear(e)) : 'No date yet';
                  const showSep = showYears && yearLabel !== prevYear;
                  prevYear = yearLabel;
                  return (
                    <React.Fragment key={e.id}>
                      {i === todayLine && <TodayIndicator />}
                      {showSep && <Ledger.Separator label={yearLabel} count={yearCounts.get(yearLabel)} />}
                      <Ledger.Row edge={edge} onOpen={() => onOpen(e.id)} className="items-start px-3 py-3">
                        <div className="w-12 shrink-0">
                          <DateStack e={e} />
                        </div>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="truncate font-medium text-text">
                            <EventTitle event={e} />
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
                            <KindPill kind={eventKind} size="sm" />
                            {e.series && (
                              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                                <SeriesDot series={e.series!} />
                                {e.series}
                              </span>
                            )}
                            {(e.venue || e.city) && (
                              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                                <MapPin className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />
                                {[e.venue, cityOf(e)].filter(Boolean).join(' · ')}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                            {e.seen.length > 0 && <span className="font-mono tabular-nums">{e.seen.length} seen</span>}
                            <DetailsCell
                              e={e}
                              state={attendanceOf(e, today)}
                              needs={needs}
                              confirmed={Boolean(e.editionId)}
                            />
                          </div>
                        </div>
                      </Ledger.Row>
                    </React.Fragment>
                  );
                });
              })()}
              {todayLine === rows.length && todayLine > 0 && <TodayIndicator />}
            </Ledger>
          </div>
        </>
      )}
      <BackToTop />
    </div>
  );
};

// The dot beside a series name, in the series' own tint (services/eventTint.ts), or the accent when tints are off.
function SeriesDot({ series }: { series: string }) {
  const hue = tintHue(series);
  return <span className="series-dot h-2 w-2 shrink-0 rounded-full bg-accent-fill" style={hue == null ? undefined : ({ '--event-hue': hue } as CSSProperties)} aria-hidden="true" />;
}
