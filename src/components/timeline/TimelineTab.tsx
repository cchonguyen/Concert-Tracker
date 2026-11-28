import React, { useEffect, useMemo, useState } from 'react';
import { CalendarRange, Table2, TriangleAlert } from 'lucide-react';
import { FilterButton, FilterPanel, FilterSelect } from '../ui/FilterControls';
import { Segmented } from '../ui/Segmented';
import type { LineupFacts, LineupSummary, LoggedEvent } from '../../services/lineupApi';
import { activeFilterCount, EMPTY_FILTERS, filterEvents, filterOptions, filtersFromQuery, filtersToQuery, TableFilters } from '../../services/table';
import { buildTimelineModel, firstToConfirm, monthFromQuery, monthToQuery, TimelineMode, TimelineRange } from '../../services/timeline';
import { AgendaView } from './AgendaView';
import { HeatmapView } from './HeatmapView';
import { MonthView } from './MonthView';
import { RiverView } from './RiverView';
import { NoDateTray } from './parts';

// One Explore page for a timeline view (Agenda, Month, Heatmap or River). The
// filters shared with the Table and Map, the "to confirm" chip, "Open in
// Table" and the No date yet tray live here, not in a view, so they stay put
// whichever view is showing. Choosing a view is the header's job (nav.ts).

interface TimelineTabProps {
  mode: TimelineMode;
  onModeChange: (mode: TimelineMode) => void;
  focusEventId?: string | null; // Opened from the "to confirm" chip on another view
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  onOpen: (id: string) => void;
  onOpenTable: (query: string) => void;
  onShowInAgenda: (id: string) => void;
}

const TIMELINE_OPTIONS: Array<{ value: TimelineMode; label: string }> = [
  { value: 'agenda', label: 'Agenda' },
  { value: 'month', label: 'Month' },
  { value: 'heatmap', label: 'Heatmap' },
  { value: 'river', label: 'River' },
];

const control =
  'min-h-11 w-full rounded-control border border-line bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9';
const ALL: TimelineRange = { kind: 'all' };

export const TimelineTab: React.FC<TimelineTabProps> = ({ mode, onModeChange, focusEventId = null, events, lineups, editions, onOpen, onOpenTable, onShowInAgenda }) => {
  const [filters, setFilters] = useState<TableFilters>(() => filtersFromQuery(window.location.search));
  const [selectedEventId, setSelectedEventId] = useState<string | null>(focusEventId);
  const [showFilters, setShowFilters] = useState(() => activeFilterCount(filters) > 0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [monthRange, setMonthRange] = useState<TimelineRange>(() => monthFromQuery(window.location.search, today));
  const options = useMemo(() => filterOptions(events), [events]);
  const filtered = useMemo(() => filterEvents(events, filters, lineups, editions), [events, filters, lineups, editions]);
  const model = useMemo(() => buildTimelineModel(filtered, today, editions), [filtered, today, editions]);
  const set = (patch: Partial<TableFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const year = (s: string) => (s ? Number(s) : undefined);
  // Filters set in the Table or Map that this tab has no control for still apply; say so.
  const shownActive = (filters.q ? 1 : 0) + (filters.yearFrom !== undefined ? 1 : 0) + (filters.kind !== 'any' ? 1 : 0);
  const hidden = activeFilterCount(filters) - shownActive;

  useEffect(() => {
    const q = filtersToQuery(filters);
    const at = mode === 'month' && monthRange.kind === 'month' ? `&month=${monthToQuery(monthRange)}` : '';
    window.history.replaceState(null, '', `${window.location.pathname}?view=${mode}${at}${q ? `&${q}` : ''}`);
  }, [filters, mode, monthRange]);

  const confirmId = firstToConfirm(model);
  const tableQuery = filtersToQuery({ ...filters, sort: EMPTY_FILTERS.sort, desc: EMPTY_FILTERS.desc });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Timeline view" compact value={mode} onChange={onModeChange} options={TIMELINE_OPTIONS} />
        <div className="flex items-center gap-3 text-xs">
          {model.toConfirm > 0 && confirmId && (
            <button
              onClick={() => {
                // Agenda is where you answer, so the chip opens it at the first one.
                if (mode === 'agenda') setSelectedEventId(confirmId);
                else onShowInAgenda(confirmId);
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-warn px-3 font-semibold text-on-warn hover:brightness-110 sm:min-h-9"
            >
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
              {model.toConfirm} to confirm
            </button>
          )}
          <button onClick={() => onOpenTable(tableQuery)} className="inline-flex min-h-11 items-center gap-1 text-text-muted hover:text-text sm:min-h-9">
            <Table2 className="h-3.5 w-3.5" /> Open in Table
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search events" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Events, venues, acts, people" className={`${control} min-w-0 flex-1 py-2`} />
        <FilterButton open={showFilters} count={activeFilterCount(filters)} onClick={() => setShowFilters((s) => !s)} />
      </div>
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
              name="Type"
              value={filters.kind === 'any' ? '' : filters.kind}
              onChange={(v) => set({ kind: (v || 'any') as TableFilters['kind'] })}
              options={[
                { value: 'concert', label: 'Concerts' },
                { value: 'festival', label: 'Festivals' },
                { value: 'unknown', label: 'Type not known' },
              ]}
            />
          </div>
        </FilterPanel>
      )}
      {hidden > 0 && (
        <p className="flex items-center gap-2 text-xs text-text-muted">
          <CalendarRange className="h-3.5 w-3.5" />
          {hidden} more filter{hidden === 1 ? '' : 's'} from the Table or Map {hidden === 1 ? 'applies' : 'apply'} here.
          <button onClick={() => setFilters({ ...EMPTY_FILTERS, q: filters.q, yearFrom: filters.yearFrom, kind: filters.kind })} className="inline-flex min-h-11 items-center sm:min-h-9 text-accent hover:text-accent">
            Clear them
          </button>
        </p>
      )}

      <NoDateTray events={model.undated} onOpen={onOpen} />

      {mode === 'agenda' && (
        <AgendaView model={model} size="large" range={ALL} selectedEventId={selectedEventId} onSelectEvent={setSelectedEventId} onOpen={onOpen} />
      )}
      {mode === 'month' && <MonthView model={model} size="large" range={monthRange} onRangeChange={setMonthRange} onOpen={onOpen} />}
      {mode === 'river' && <RiverView model={model} size="large" range={ALL} onOpen={onOpen} onShowInAgenda={onShowInAgenda} />}
      {mode === 'heatmap' && (
        <HeatmapView model={model} size="large" range={ALL} selectedDate={selectedDate} onSelectDate={setSelectedDate} onOpen={onOpen} />
      )}
    </div>
  );
};
