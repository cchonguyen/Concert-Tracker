import React, { useEffect, useMemo, useState } from 'react';
import { CalendarRange, Table2 } from 'lucide-react';
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
  focusEventId?: string | null; // Opened from the "to confirm" chip on another view
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  onOpen: (id: string) => void;
  onOpenTable: (query: string) => void;
  onShowToConfirm: (id: string) => void;
}

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const label = 'space-y-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
const ALL: TimelineRange = { kind: 'all' };

export const TimelineTab: React.FC<TimelineTabProps> = ({ mode, focusEventId = null, events, lineups, editions, onOpen, onOpenTable, onShowToConfirm }) => {
  const [filters, setFilters] = useState<TableFilters>(() => filtersFromQuery(window.location.search));
  const [selectedEventId, setSelectedEventId] = useState<string | null>(focusEventId);
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-3 text-xs">
          {model.toConfirm > 0 && confirmId && (
            <button
              onClick={() => {
                // Agenda is where you answer, so the chip opens it at the first one.
                if (mode === 'agenda') setSelectedEventId(confirmId);
                else onShowToConfirm(confirmId);
              }}
              className="rounded-full border border-dashed border-amber-400/60 px-2.5 py-1 font-semibold text-amber-300 hover:bg-amber-400/10"
            >
              {model.toConfirm} to confirm
            </button>
          )}
          <button onClick={() => onOpenTable(tableQuery)} className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200">
            <Table2 className="h-3.5 w-3.5" /> Open in Table
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className={`${label} col-span-2`}>
          <span>Search</span>
          <input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Events, venues, acts, people" className={control} />
        </label>
        <label className={label}>
          <span>From year</span>
          <select value={filters.yearFrom ?? ''} onChange={(e) => set({ yearFrom: year(e.target.value) })} className={control}>
            <option value="">Any</option>
            {options.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span>Type</span>
          <select value={filters.kind === 'any' ? '' : filters.kind} onChange={(e) => set({ kind: (e.target.value || 'any') as TableFilters['kind'] })} className={control}>
            <option value="">Any</option>
            <option value="concert">Concert</option>
            <option value="festival">Festival</option>
            <option value="unknown">Not known yet</option>
          </select>
        </label>
      </div>
      {hidden > 0 && (
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <CalendarRange className="h-3.5 w-3.5" />
          {hidden} more filter{hidden === 1 ? '' : 's'} from the Table or Map {hidden === 1 ? 'applies' : 'apply'} here.
          <button onClick={() => setFilters({ ...EMPTY_FILTERS, q: filters.q, yearFrom: filters.yearFrom, kind: filters.kind })} className="text-violet-300 hover:text-violet-200">
            Clear them
          </button>
        </p>
      )}

      <NoDateTray events={model.undated} onOpen={onOpen} />

      {mode === 'agenda' && (
        <AgendaView model={model} size="large" range={ALL} selectedEventId={selectedEventId} onSelectEvent={setSelectedEventId} onOpen={onOpen} />
      )}
      {mode === 'month' && <MonthView model={model} size="large" range={monthRange} onRangeChange={setMonthRange} onOpen={onOpen} />}
      {mode === 'river' && <RiverView model={model} size="large" range={ALL} onOpen={onOpen} />}
      {mode === 'heatmap' && (
        <HeatmapView model={model} size="large" range={ALL} selectedDate={selectedDate} onSelectDate={setSelectedDate} onOpen={onOpen} />
      )}
    </div>
  );
};
