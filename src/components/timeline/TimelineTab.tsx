import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CalendarRange, Grid3x3, ListOrdered, Table2, Waves } from 'lucide-react';
import type { LineupFacts, LineupSummary, LoggedEvent } from '../../services/lineupApi';
import { activeFilterCount, EMPTY_FILTERS, filterEvents, filterOptions, filtersFromQuery, filtersToQuery, TableFilters } from '../../services/table';
import { buildTimelineModel, DEFAULT_MODE, firstToConfirm, modeFromQuery, TIMELINE_VIEWS, TimelineMode, TimelineRange } from '../../services/timeline';
import { AgendaView } from './AgendaView';
import { NoDateTray } from './parts';

// The Timeline tab: the view switcher, filters shared with the Table and
// Map, the "to confirm" chip, "Open in Table" and the No date yet tray. These
// live here, not in a view, so they stay put whichever view is showing.

interface TimelineTabProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  onOpen: (id: string) => void;
  onOpenTable: (query: string) => void;
}

const ICONS: Record<TimelineMode, React.ComponentType<{ className?: string }>> = {
  agenda: ListOrdered,
  month: CalendarDays,
  heatmap: Grid3x3,
  river: Waves,
};

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const label = 'space-y-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
const ALL: TimelineRange = { kind: 'all' };

export const TimelineTab: React.FC<TimelineTabProps> = ({ events, lineups, editions, onOpen, onOpenTable }) => {
  const [filters, setFilters] = useState<TableFilters>(() => filtersFromQuery(window.location.search));
  const [mode, setMode] = useState<TimelineMode>(() => modeFromQuery(window.location.search));
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
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
    const m = mode === DEFAULT_MODE ? '' : `&mode=${mode}`;
    window.history.replaceState(null, '', `${window.location.pathname}?view=timeline${m}${q ? `&${q}` : ''}`);
  }, [filters, mode]);

  const confirmId = firstToConfirm(model);
  const tableQuery = filtersToQuery({ ...filters, sort: EMPTY_FILTERS.sort, desc: EMPTY_FILTERS.desc });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1 text-sm" aria-label="Timeline view">
          {TIMELINE_VIEWS.map((v) => {
            const Icon = ICONS[v.id];
            return (
              <button
                key={v.id}
                disabled={!v.ready}
                onClick={() => setMode(v.id)}
                title={v.ready ? v.label : `${v.label}: coming soon`}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium transition-colors ${
                  mode === v.id ? 'bg-violet-600 text-white' : v.ready ? 'text-zinc-400 hover:text-zinc-200' : 'cursor-not-allowed text-zinc-700'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className={mode === v.id ? '' : 'hidden sm:inline'}>{v.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="flex items-center gap-3 text-xs">
          {model.toConfirm > 0 && confirmId && (
            <button
              onClick={() => setSelectedEventId(confirmId)}
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
    </div>
  );
};
