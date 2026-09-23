import React from 'react';
import {
  TrendingUp,
  Award,
  Building,
  Calendar,
  DollarSign,
  Users,
  Sun,
  Flame,
  ArrowUpRight,
  Sparkles,
  Music2,
  PieChart,
  BarChart3,
  Globe,
  CheckCircle2,
  Ticket,
} from 'lucide-react';
import { HabitTelemetrySummary } from '../services/analytics';
import { PopulatedEvent } from '../types/schema';

interface AnalyticsViewProps {
  telemetry: HabitTelemetrySummary;
  events: PopulatedEvent[];
  onSelectArtistMbid: (artist: { id: string; name: string }) => void;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  telemetry,
  events,
  onSelectArtistMbid,
}) => {
  return (
    <div className="space-y-8 py-6">
      {/* Title */}
      <div className="space-y-1">
        <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-950/40 px-3 py-1 text-xs font-medium text-violet-300">
          <TrendingUp className="h-3.5 w-3.5 text-violet-400" />
          <span>Behavioral Analytics & Attendance Telemetry</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Concert Habit Telemetry & Affinity Engine
        </h2>
        <p className="text-xs text-zinc-400">
          Transforming historical event logs into actionable behavioral insights, festival attendance ratios, loyalty ranks, and touring velocity.
        </p>
      </div>

      {/* Primary KPI Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-md space-y-1">
          <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            Total Manifests
          </div>
          <div className="text-2xl font-extrabold text-white">{telemetry.totalEvents}</div>
          <div className="text-[10px] text-zinc-500">Live performances</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-md space-y-1">
          <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            Unique Artists
          </div>
          <div className="text-2xl font-extrabold text-violet-400">
            {telemetry.uniqueArtists}
          </div>
          <div className="text-[10px] text-zinc-500">Itemized performers</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-md space-y-1">
          <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            Unique Venues
          </div>
          <div className="text-2xl font-extrabold text-indigo-400">
            {telemetry.uniqueVenues}
          </div>
          <div className="text-[10px] text-zinc-500">Across states</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-md space-y-1">
          <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            Outdoor Staging
          </div>
          <div className="text-2xl font-extrabold text-emerald-400">
            {telemetry.outdoorPercentage}%
          </div>
          <div className="text-[10px] text-zinc-500">Open-air loyalty</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-md space-y-1">
          <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            Festival Days
          </div>
          <div className="text-2xl font-extrabold text-amber-300">
            {telemetry.attendedFestivalDays} <span className="text-sm font-normal text-zinc-400">/ {telemetry.totalFestivalDays}</span>
          </div>
          <div className="text-[10px] text-zinc-500">{telemetry.festivalAttendanceRate}% day attendance rate</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-md space-y-1">
          <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            Cumulative Spend
          </div>
          <div className="text-2xl font-extrabold text-amber-400">
            ${telemetry.totalExpenditure}
          </div>
          <div className="text-[10px] text-zinc-500">Tracked ledger</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-md space-y-1">
          <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            Cost / Live Day
          </div>
          <div className="text-2xl font-extrabold text-cyan-400">
            ${telemetry.costPerAttendedDay}
          </div>
          <div className="text-[10px] text-zinc-500">Per attended day</div>
        </div>
      </div>

      {/* Multi-Day Festival Attendance Telemetry Section */}
      <div className="rounded-2xl border border-amber-500/40 bg-zinc-900/60 p-6 shadow-xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-amber-500/20 p-2.5 text-amber-400 border border-amber-500/30">
              <span className="text-xl">🎪</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">Multi-Day Festival Runs & Attendance Ratios</h3>
                <span className="rounded-full bg-amber-500/20 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                  {telemetry.totalFestivalEvents} Festival {telemetry.totalFestivalEvents === 1 ? 'Run' : 'Runs'}
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Tracking scheduled multi-day festival spans against the exact calendar days you attended
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="rounded-xl bg-zinc-950/80 border border-zinc-800 px-3 py-2 text-right">
              <span className="text-zinc-500 block text-[10px] uppercase font-sans">Festival Attendance</span>
              <span className="text-emerald-400 font-bold text-sm">
                {telemetry.attendedFestivalDays} of {telemetry.totalFestivalDays} Days ({telemetry.festivalAttendanceRate}%)
              </span>
            </div>
          </div>
        </div>

        {telemetry.festivalBreakdown.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {telemetry.festivalBreakdown.map((fest) => {
              return (
                <div
                  key={fest.eventId}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-3.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-bold text-white flex items-center gap-1.5">
                        <span>{fest.eventName}</span>
                        {fest.totalDays > 1 && (
                          <span className="rounded bg-amber-950/60 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                            {fest.totalDays} Days
                          </span>
                        )}
                      </h4>
                      <div className="text-[11px] text-zinc-400 flex items-center gap-1.5 mt-0.5">
                        <Calendar className="h-3 w-3 text-zinc-500" />
                        <span>
                          {fest.startDate}
                          {fest.endDate && fest.endDate !== fest.startDate && ` → ${fest.endDate}`}
                        </span>
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold border ${
                          fest.attendedDaysCount === fest.totalDays
                            ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300'
                            : fest.attendedDaysCount > 0
                              ? 'border-amber-500/40 bg-amber-950/30 text-amber-300'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {fest.attendedDaysCount} / {fest.totalDays} Attended ({fest.attendancePercentage}%)
                      </span>
                    </div>
                  </div>

                  {/* Attendance ratio progress bar */}
                  <div className="space-y-1">
                    <div className="h-2 w-full rounded-full bg-zinc-900 border border-zinc-800 overflow-hidden flex">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all"
                        style={{ width: `${fest.attendancePercentage}%` }}
                      />
                      <div
                        className="h-full bg-zinc-800 transition-all"
                        style={{ width: `${100 - fest.attendancePercentage}%` }}
                      />
                    </div>
                  </div>

                  {/* Itemized day breakdown */}
                  <div className="space-y-1.5 pt-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Day-by-Day Attendance Record:
                    </div>
                    <div className="space-y-1">
                      {fest.days.map((day) => (
                        <div
                          key={day.day_index}
                          className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs border ${
                            day.attended
                              ? 'border-emerald-500/30 bg-emerald-950/20 text-zinc-200'
                              : 'border-zinc-800/80 bg-zinc-900/30 text-zinc-500 opacity-70'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`h-2 w-2 rounded-full flex-shrink-0 ${
                                day.attended ? 'bg-emerald-400' : 'bg-zinc-600'
                              }`}
                            />
                            <span className="font-semibold text-xs truncate">
                              {day.label || `Day ${day.day_index}`}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-400">({day.date})</span>
                            {day.notes && (
                              <span className="text-[11px] text-zinc-400 italic truncate hidden sm:inline">
                                · {day.notes}
                              </span>
                            )}
                          </div>

                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                              day.attended
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-zinc-800 text-zinc-500'
                            }`}
                          >
                            {day.attended ? '✓ Attended' : '✕ Skipped'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-8 text-center text-xs text-zinc-500 space-y-1">
            <span className="text-3xl block mb-2">🎪</span>
            <p>No multi-day festivals recorded in the database yet.</p>
            <p className="text-[11px]">
              Extract a multi-day festival (e.g., Coachella Valley Music & Arts Festival or Zedd in the Park) to unlock deep attendance telemetry.
            </p>
          </div>
        )}
      </div>

      {/* Grid: Artist Affinity & Venue Loyalty */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 1. Artist Affinity Indices */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="rounded-xl bg-violet-600/20 p-2 text-violet-400 border border-violet-500/30">
                <Flame className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Artist Affinity Indices</h3>
                <p className="text-xs text-zinc-400">
                  Segregating headline viewings from multi-act festival appearances
                </p>
              </div>
            </div>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-300">
              Top Ranked
            </span>
          </div>

          <div className="space-y-3 pt-2">
            {telemetry.artistAffinities.slice(0, 6).map((art, idx) => (
              <div
                key={art.artistId}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-800 font-mono text-xs font-bold text-zinc-400">
                    #{idx + 1}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white text-sm">{art.artistName}</span>
                      <span
                        className={`rounded px-1.5 py-0.2 text-[10px] font-semibold uppercase ${
                          art.affinityTier === 'Obsession'
                            ? 'bg-red-950 text-red-300 border border-red-500/30'
                            : art.affinityTier === 'Core Favorite'
                            ? 'bg-violet-950 text-violet-300 border border-violet-500/30'
                            : 'bg-zinc-800 text-zinc-300'
                        }`}
                      >
                        {art.affinityTier}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      Seen {art.firstSeenDate} to {art.lastSeenDate}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {/* Decomposition Pills */}
                  <div className="flex items-center gap-1 text-[11px]">
                    <span className="rounded bg-violet-950/80 border border-violet-500/20 px-1.5 py-0.5 text-violet-300">
                      {art.headlineCount} Headliner
                    </span>
                    {art.supportCount > 0 && (
                      <span className="rounded bg-emerald-950/80 border border-emerald-500/20 px-1.5 py-0.5 text-emerald-300">
                        {art.supportCount} Support
                      </span>
                    )}
                    {art.festivalCount > 0 && (
                      <span className="rounded bg-amber-950/80 border border-amber-500/20 px-1.5 py-0.5 text-amber-300">
                        {art.festivalCount} Fest
                      </span>
                    )}
                  </div>

                  <span className="font-mono text-sm font-bold text-white w-6 text-right">
                    {art.totalAppearances}x
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 2. Venue Loyalty Metrics */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="rounded-xl bg-indigo-600/20 p-2 text-indigo-400 border border-indigo-500/30">
                <Building className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Venue Loyalty Metrics</h3>
                <p className="text-xs text-zinc-400">
                  Ranked by visit frequency and indoor versus open-air staging
                </p>
              </div>
            </div>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-300">
              Facility Ranks
            </span>
          </div>

          <div className="space-y-3 pt-2">
            {telemetry.venueLoyalties.slice(0, 6).map((ven) => (
              <div
                key={ven.venueId}
                className="flex items-center justify-between rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-800 font-mono text-xs font-bold text-zinc-400">
                    #{ven.loyaltyRank}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white text-sm">{ven.venueName}</span>
                      <span
                        className={`rounded px-1.5 py-0.2 text-[10px] font-medium ${
                          ven.isOutdoor
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/20'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {ven.isOutdoor ? 'Open-Air' : 'Indoor Arena'}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-500">{ven.location}</div>
                  </div>
                </div>

                <div className="text-right">
                  <span className="font-mono text-sm font-bold text-white">
                    {ven.visitCount} {ven.visitCount === 1 ? 'Visit' : 'Visits'}
                  </span>
                  <div className="text-[10px] text-zinc-500">
                    Latest: {ven.lastVisit}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Grid: Temporal Velocity & Lineup Overlap */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 3. Temporal Velocity & Annual Expenditure */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl space-y-4">
          <div className="flex items-center gap-2">
            <div className="rounded-xl bg-cyan-600/20 p-2 text-cyan-400 border border-cyan-500/30">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Temporal Velocity & Cadence</h3>
              <p className="text-xs text-zinc-400">
                Touring cadence, seasonal distribution, and annual expenditure velocity
              </p>
            </div>
          </div>

          <div className="space-y-4 pt-2">
            {telemetry.temporalVelocity.map((period) => {
              const maxShows = Math.max(...telemetry.temporalVelocity.map((p) => p.count), 1);
              const barWidth = Math.round((period.count / maxShows) * 100);

              return (
                <div key={period.periodKey} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-white">{period.label}</span>
                    <div className="flex items-center gap-3 text-zinc-400">
                      <span>{period.count} concerts</span>
                      <span className="font-mono text-emerald-400 font-semibold">
                        ${period.totalSpend}
                      </span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="h-3 w-full rounded-full bg-zinc-950 overflow-hidden border border-zinc-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-400"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>

                  {period.headliners.length > 0 && (
                    <div className="text-[11px] text-zinc-500 truncate">
                      Headliners: {period.headliners.slice(0, 4).join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 4. Lineup Overlap Ratios */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl space-y-4">
          <div className="flex items-center gap-2">
            <div className="rounded-xl bg-amber-600/20 p-2 text-amber-400 border border-amber-500/30">
              <PieChart className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Lineup Overlap Ratios</h3>
              <p className="text-xs text-zinc-400">
                Recurring pairings between supporting acts and primary touring headliners
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            {telemetry.lineupOverlaps.length > 0 ? (
              telemetry.lineupOverlaps.map((overlap, idx) => (
                <div
                  key={idx}
                  className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3 text-xs space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-violet-300">
                        {overlap.primaryHeadliner}
                      </span>
                      <span className="text-zinc-500">+</span>
                      <span className="font-semibold text-emerald-300">
                        {overlap.supportingAct}
                      </span>
                    </div>
                    <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300 font-bold">
                      {overlap.sharedShowsCount} shared {overlap.sharedShowsCount === 1 ? 'show' : 'shows'}
                    </span>
                  </div>

                  {overlap.tours.length > 0 && (
                    <div className="text-[11px] text-zinc-400">
                      Associated Tours: {overlap.tours.join(' · ')}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-xs text-zinc-500 space-y-1">
                <Music2 className="h-6 w-6 mx-auto text-zinc-600" />
                <p>No multi-act headliner/support overlaps detected yet.</p>
                <p className="text-[11px]">Add more concerts with touring support acts to see pairings.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
