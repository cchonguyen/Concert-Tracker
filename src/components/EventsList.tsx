import React, { useState, useMemo } from 'react';
import {
  Calendar,
  Building2,
  Music,
  Disc,
  ExternalLink,
  Trash2,
  Search,
  Filter,
  Users,
  DollarSign,
  Star,
  CheckCircle,
  FileSpreadsheet,
  Globe,
  Sun,
  LayoutGrid,
  Table as TableIcon,
  Sparkles,
} from 'lucide-react';
import { Artist, PopulatedEvent } from '../types/schema';
import { concertStore } from '../services/storage';

interface EventsListProps {
  events: PopulatedEvent[];
  onSelectSetlist: (event: PopulatedEvent) => void;
  onSelectArtistMbid: (artist: Artist) => void;
  onSyncSheets: (event: PopulatedEvent) => void;
  onRefresh: () => void;
  onGoToExtraction: () => void;
}

export const EventsList: React.FC<EventsListProps> = ({
  events,
  onSelectSetlist,
  onSelectArtistMbid,
  onSyncSheets,
  onRefresh,
  onGoToExtraction,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterOutdoor, setFilterOutdoor] = useState<boolean | null>(null);
  const [filterSetlistConfirmed, setFilterSetlistConfirmed] = useState<boolean>(false);
  const [filterFestivalsOnly, setFilterFestivalsOnly] = useState<boolean>(false);
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  // Extract unique years
  const availableYears = useMemo(() => {
    const years = new Set<string>();
    events.forEach((e) => {
      if (e.event_date) years.add(e.event_date.slice(0, 4));
    });
    return Array.from(years).sort().reverse();
  }, [events]);

  // Filtered Events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      // Search matching
      const q = searchQuery.toLowerCase().trim();
      if (q) {
        const matchesName = e.name.toLowerCase().includes(q);
        const matchesTour = e.tour_name?.toLowerCase().includes(q);
        const matchesVenue = e.venue.name.toLowerCase().includes(q) || e.venue.city.toLowerCase().includes(q);
        const matchesArtist = e.appearances.some((a) =>
          a.artist.name.toLowerCase().includes(q),
        );
        const matchesCompanion = (e.companions || []).some((c) =>
          c.toLowerCase().includes(q),
        );
        if (!matchesName && !matchesTour && !matchesVenue && !matchesArtist && !matchesCompanion) {
          return false;
        }
      }

      // Year filter
      if (selectedYear !== 'all') {
        if (!e.event_date.startsWith(selectedYear)) return false;
      }

      // Outdoor filter
      if (filterOutdoor !== null) {
        if (!!e.venue.isOutdoor !== filterOutdoor) return false;
      }

      // Setlist confirmed filter
      if (filterSetlistConfirmed && !e.setlist_confirmed) {
        return false;
      }

      // Festivals only filter
      if (filterFestivalsOnly) {
        const isFest = e.is_festival || (e.festival_days && e.festival_days.length > 0);
        if (!isFest) return false;
      }

      return true;
    });
  }, [events, searchQuery, selectedYear, filterOutdoor, filterSetlistConfirmed, filterFestivalsOnly]);

  const handleDelete = (eventId: string, eventName: string) => {
    if (window.confirm(`Are you sure you want to remove "${eventName}" from the relational archive?`)) {
      concertStore.deleteEvent(eventId);
      onRefresh();
    }
  };

  return (
    <div className="space-y-6 py-4">
      {/* Top Filter & Search Bar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
        {/* Search */}
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
            <Search className="h-4 w-4" />
          </div>
          <input
            type="text"
            placeholder="Search events by headliner, tour, venue, city, or companion..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/70 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
          />
        </div>

        {/* Filter Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Year selector */}
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            className="rounded-xl border border-zinc-700/80 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-violet-500 focus:outline-none"
          >
            <option value="all">All Years</option>
            {availableYears.map((yr) => (
              <option key={yr} value={yr}>
                {yr}
              </option>
            ))}
          </select>

          {/* Outdoor filter toggle */}
          <button
            type="button"
            onClick={() =>
              setFilterOutdoor((prev) => (prev === null ? true : prev === true ? false : null))
            }
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
              filterOutdoor === true
                ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300'
                : filterOutdoor === false
                ? 'border-blue-500/40 bg-blue-950/40 text-blue-300'
                : 'border-zinc-700/80 bg-zinc-950/80 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Sun className="h-3.5 w-3.5" />
            <span>
              {filterOutdoor === true
                ? 'Outdoor Only'
                : filterOutdoor === false
                ? 'Indoor Only'
                : 'Staging'}
            </span>
          </button>

          {/* Setlist confirmed toggle */}
          <button
            type="button"
            onClick={() => setFilterSetlistConfirmed((prev) => !prev)}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
              filterSetlistConfirmed
                ? 'border-violet-500/40 bg-violet-950/40 text-violet-300'
                : 'border-zinc-700/80 bg-zinc-950/80 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Disc className="h-3.5 w-3.5" />
            <span>Setlist Confirmed</span>
          </button>

          {/* Festivals only filter */}
          <button
            type="button"
            onClick={() => setFilterFestivalsOnly((prev) => !prev)}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
              filterFestivalsOnly
                ? 'border-amber-500/50 bg-amber-950/40 text-amber-300 shadow-sm'
                : 'border-zinc-700/80 bg-zinc-950/80 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <span>🎪 Festivals Only</span>
          </button>

          {/* View switcher */}
          <div className="flex items-center rounded-xl border border-zinc-800 bg-zinc-950 p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={`rounded-lg p-1.5 text-xs ${
                viewMode === 'grid' ? 'bg-zinc-800 text-white' : 'text-zinc-400'
              }`}
              title="Card Grid"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`rounded-lg p-1.5 text-xs ${
                viewMode === 'table' ? 'bg-zinc-800 text-white' : 'text-zinc-400'
              }`}
              title="Tabular View"
            >
              <TableIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Results Header */}
      <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
        <span>
          Showing <strong className="text-zinc-200">{filteredEvents.length}</strong> of{' '}
          <strong className="text-zinc-200">{events.length}</strong> live concert manifests
        </span>
        <button
          onClick={onGoToExtraction}
          className="flex items-center gap-1.5 font-medium text-violet-400 hover:underline"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>+ Research New Event</span>
        </button>
      </div>

      {/* Content Rendering: Grid vs Table */}
      {filteredEvents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-800 p-12 text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-900 text-zinc-500">
            <Music className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-zinc-300">No matching concerts found</h3>
            <p className="text-xs text-zinc-500">
              Try adjusting your query filters or extract a new concert event using Google AI Studio.
            </p>
          </div>
          <button
            onClick={onGoToExtraction}
            className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500 transition-colors"
          >
            Launch Grounded Extraction
          </button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filteredEvents.map((event) => {
            const headliners = event.appearances.filter((a) => a.billing_role === 'headliner');
            const supportActs = event.appearances.filter(
              (a) => a.billing_role === 'support' || a.billing_role === 'guest',
            );

            const isFestival = event.is_festival || (event.festival_days && event.festival_days.length > 0);
            const totalFestivalDays = event.festival_days?.length || (isFestival ? 1 : 0);
            const attendedFestivalDays = event.festival_days
              ? event.festival_days.filter((d) => d.attended).length
              : isFestival
                ? (event.attendance_status === 'attended' ? 1 : 0)
                : 0;
            const festivalPct = totalFestivalDays > 0 ? Math.round((attendedFestivalDays / totalFestivalDays) * 100) : 100;

            return (
              <div
                key={event.id}
                className="group relative flex flex-col justify-between rounded-2xl border border-zinc-800/90 bg-zinc-900/60 p-5 shadow-lg hover:border-zinc-700 transition-all space-y-4"
              >
                {/* Card Top: Date & Tour */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-[11px] font-semibold text-zinc-300">
                        <Calendar className="h-3 w-3 text-zinc-400" />
                        {event.event_date}
                        {isFestival && event.end_date && event.end_date !== event.event_date && (
                          <span className="text-zinc-500">→ {event.end_date}</span>
                        )}
                      </span>

                      {isFestival && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-950/40 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                          <span>🎪</span>
                          <span>{totalFestivalDays > 1 ? `${totalFestivalDays}-Day Festival` : 'Festival'}</span>
                        </span>
                      )}

                      {isFestival && totalFestivalDays > 0 && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold border ${
                            attendedFestivalDays === totalFestivalDays
                              ? 'border-emerald-500/30 bg-emerald-950/40 text-emerald-300'
                              : attendedFestivalDays > 0
                                ? 'border-amber-500/30 bg-amber-950/30 text-amber-300'
                                : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          <span>
                            {attendedFestivalDays}/{totalFestivalDays} Days Attended ({festivalPct}%)
                          </span>
                        </span>
                      )}

                      {event.tour_name && (
                        <span className="rounded-md border border-violet-500/30 bg-violet-950/40 px-2 py-0.5 text-[11px] font-medium text-violet-300 truncate max-w-[200px]">
                          {event.tour_name}
                        </span>
                      )}
                      {event.engine_metadata?.extractionModel && (
                        <span className="rounded-md border border-cyan-500/30 bg-cyan-950/40 px-2 py-0.5 text-[10px] font-mono text-cyan-300">
                          {event.engine_metadata.extractionModel}
                        </span>
                      )}
                    </div>
                    <h3 className="text-base font-bold text-white group-hover:text-violet-300 transition-colors">
                      {event.name}
                    </h3>
                  </div>

                  {/* Actions & Rating */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onSyncSheets(event)}
                      className="rounded-lg p-1.5 text-zinc-400 hover:bg-emerald-950/40 hover:text-emerald-300 transition-colors"
                      title="Dispatch Downstream Sheets Replica Sync"
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(event.id, event.name)}
                      className="rounded-lg p-1.5 text-zinc-500 hover:bg-red-950/40 hover:text-red-400 transition-colors"
                      title="Delete event"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Venue Details */}
                <div className="flex items-center justify-between text-xs text-zinc-400 border-y border-zinc-800/60 py-2">
                  <div className="flex items-center gap-1.5">
                    <Building2 className="h-3.5 w-3.5 text-zinc-500" />
                    <span className="font-medium text-zinc-300">{event.venue.name}</span>
                    <span>·</span>
                    <span>
                      {event.venue.city}
                      {event.venue.state ? `, ${event.venue.state}` : ''}
                    </span>
                  </div>

                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      event.venue.isOutdoor
                        ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/20'
                        : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    {event.venue.isOutdoor ? 'Outdoor' : 'Indoor'}
                  </span>
                </div>

                {/* Lineup Decomposition */}
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Lineup Decomposition
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {event.appearances.map((app) => {
                      const isHeadliner = app.billing_role === 'headliner';
                      return (
                        <div
                          key={app.id}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
                            isHeadliner
                              ? 'border-violet-500/40 bg-violet-950/30 text-violet-200'
                              : 'border-zinc-700/80 bg-zinc-950/60 text-zinc-300'
                          }`}
                        >
                          <span className="font-semibold">{app.artist.name}</span>
                          <span className="text-[10px] opacity-60 capitalize">
                            ({app.billing_role})
                          </span>

                          {/* MusicBrainz Resolver Trigger */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectArtistMbid(app.artist);
                            }}
                            className={`rounded p-0.5 transition-colors ${
                              app.artist.musicbrainz_id
                                ? 'text-violet-400 hover:text-violet-300'
                                : 'text-zinc-500 hover:text-amber-400'
                            }`}
                            title={
                              app.artist.musicbrainz_id
                                ? `Canonical MBID: ${app.artist.musicbrainz_id}`
                                : 'Resolve Canonical MusicBrainz MBID'
                            }
                          >
                            <Globe className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Multi-Day Festival Day-by-Day Attendance Strip */}
                {isFestival && event.festival_days && event.festival_days.length > 0 && (
                  <div className="rounded-xl border border-amber-500/30 bg-zinc-950/70 p-3 space-y-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
                        <span>🎪 Daily Attendance Breakdown</span>
                        <span className="text-[10px] text-zinc-400 font-normal lowercase">(click pill to toggle)</span>
                      </span>
                      <span className="text-zinc-300 font-mono text-[10px]">
                        {attendedFestivalDays} / {totalFestivalDays} Attended
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {event.festival_days.map((day) => (
                        <button
                          key={day.day_index}
                          type="button"
                          onClick={() => {
                            concertStore.toggleFestivalDayAttendance(event.id, day.day_index);
                            onRefresh();
                          }}
                          className={`flex items-start justify-between gap-2 rounded-lg border p-2 text-left transition-all ${
                            day.attended
                              ? 'border-emerald-500/40 bg-emerald-950/25 hover:bg-emerald-900/30'
                              : 'border-zinc-800 bg-zinc-900/40 hover:bg-zinc-800/40 opacity-70'
                          }`}
                          title="Click to toggle your attendance for this day"
                        >
                          <div className="space-y-0.5 min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`h-2 w-2 rounded-full flex-shrink-0 ${
                                  day.attended ? 'bg-emerald-400' : 'bg-zinc-600'
                                }`}
                              />
                              <span
                                className={`text-xs font-semibold truncate ${
                                  day.attended ? 'text-zinc-100' : 'text-zinc-400'
                                }`}
                              >
                                {day.label || `Day ${day.day_index}`}
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-zinc-400 pl-3.5">
                              {day.date}
                            </div>
                            {day.notes && (
                              <div className="text-[10px] text-zinc-400 italic pl-3.5 line-clamp-1">
                                {day.notes}
                              </div>
                            )}
                          </div>

                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                              day.attended
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                : 'bg-zinc-800 text-zinc-500 border border-zinc-700/50'
                            }`}
                          >
                            {day.attended ? '✓ Attended' : '✕ Skipped'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Companion & Ticket Ledger Bottom Info */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Ticket Price */}
                    {event.ticket_price != null && (
                      <span className="flex items-center gap-1 rounded bg-zinc-800/80 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                        <DollarSign className="h-3 w-3 text-emerald-400" />
                        ${event.ticket_price}
                      </span>
                    )}

                    {/* Seating Tier */}
                    {event.seating_tier && (
                      <span className="rounded bg-zinc-800/80 px-2 py-0.5 text-[11px] text-zinc-400">
                        {event.seating_tier}
                      </span>
                    )}

                    {/* Companions */}
                    {event.companions && event.companions.length > 0 && (
                      <span className="flex items-center gap-1 rounded bg-zinc-800/80 px-2 py-0.5 text-[11px] text-zinc-400">
                        <Users className="h-3 w-3 text-zinc-400" />
                        {event.companions.join(', ')}
                      </span>
                    )}
                  </div>

                  {/* Setlist trigger */}
                  <button
                    onClick={() => onSelectSetlist(event)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                      event.setlist_confirmed
                        ? 'border-violet-500/30 bg-violet-950/40 text-violet-300 hover:bg-violet-900/50'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <Disc className="h-3 w-3" />
                    <span>{event.setlist_confirmed ? 'Setlist Confirmed' : 'Search Setlist'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Tabular View */
        <div className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-900/70 shadow-lg">
          <table className="w-full text-left text-xs text-zinc-300">
            <thead className="border-b border-zinc-800 bg-zinc-950 text-zinc-400">
              <tr>
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Event / Tour</th>
                <th className="px-4 py-3 font-semibold">Venue & City</th>
                <th className="px-4 py-3 font-semibold">Artists (Decomposed)</th>
                <th className="px-4 py-3 font-semibold">Price / Tier</th>
                <th className="px-4 py-3 font-semibold">Setlist</th>
                <th className="px-4 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {filteredEvents.map((event) => {
                const isFestival = event.is_festival || (event.festival_days && event.festival_days.length > 0);
                const totalDays = event.festival_days?.length || (isFestival ? 1 : 0);
                const attendedDays = event.festival_days
                  ? event.festival_days.filter((d) => d.attended).length
                  : isFestival
                    ? (event.attendance_status === 'attended' ? 1 : 0)
                    : 0;

                return (
                  <tr key={event.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-zinc-400">
                      <div>{event.event_date}</div>
                      {isFestival && event.end_date && event.end_date !== event.event_date && (
                        <div className="text-[10px] text-zinc-500">→ {event.end_date}</div>
                      )}
                      {isFestival && (
                        <div className="mt-1 flex items-center gap-1">
                          <span className="rounded bg-amber-950/60 border border-amber-500/30 px-1.5 py-0.2 text-[9px] font-bold text-amber-300">
                            🎪 {attendedDays}/{totalDays} Attended
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-bold text-white flex items-center gap-1.5">
                        {event.name}
                        {isFestival && <span className="text-[11px]">🎪</span>}
                      </div>
                      {event.tour_name && (
                        <div className="text-[11px] text-violet-400">{event.tour_name}</div>
                      )}
                      {isFestival && event.festival_days && event.festival_days.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {event.festival_days.map((d) => (
                            <button
                              key={d.day_index}
                              type="button"
                              onClick={() => {
                                concertStore.toggleFestivalDayAttendance(event.id, d.day_index);
                                onRefresh();
                              }}
                              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold border transition-all ${
                                d.attended
                                  ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/60'
                                  : 'bg-zinc-800/80 border-zinc-700/60 text-zinc-500 hover:text-zinc-300'
                              }`}
                              title={`Click to toggle Day ${d.day_index} (${d.date}): ${d.attended ? 'Attended' : 'Skipped'}`}
                            >
                              {d.label || `Day ${d.day_index}`}: {d.attended ? '✓' : '✕'}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-200">{event.venue.name}</div>
                      <div className="text-[11px] text-zinc-500">
                        {event.venue.city}, {event.venue.state}
                      </div>
                    </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {event.appearances.map((a) => (
                        <span
                          key={a.id}
                          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
                        >
                          {a.artist.name}{' '}
                          <span className="text-[9px] opacity-60">({a.billing_role})</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {event.ticket_price != null ? `$${event.ticket_price}` : '—'}
                    {event.seating_tier && (
                      <span className="block text-[10px] text-zinc-500">{event.seating_tier}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <button
                      onClick={() => onSelectSetlist(event)}
                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                        event.setlist_confirmed
                          ? 'bg-violet-950 text-violet-300 border border-violet-500/30'
                          : 'bg-zinc-800 text-zinc-500'
                      }`}
                    >
                      <Disc className="h-3 w-3" />
                      <span>{event.setlist_confirmed ? 'Confirmed' : 'Pending'}</span>
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => onSyncSheets(event)}
                        className="rounded p-1 text-zinc-400 hover:text-emerald-400"
                        title="Sync to Sheets"
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(event.id, event.name)}
                        className="rounded p-1 text-zinc-500 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
