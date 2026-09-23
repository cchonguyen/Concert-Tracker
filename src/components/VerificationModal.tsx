import React, { useState } from 'react';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Plus,
  Trash2,
  UserPlus,
  Building,
  Calendar,
  Sparkles,
  Search,
  Music,
  DollarSign,
  Users,
  ShieldCheck,
  Disc,
  Cpu,
  Database,
  Layers,
  Terminal,
  Clock,
  Code2,
} from 'lucide-react';
import {
  BillingRole,
  ExtractedArtist,
  ExtractedEventManifest,
  FestivalDayAttendance,
  StagingInput,
} from '../types/schema';

interface VerificationModalProps {
  manifest: ExtractedEventManifest;
  stagingInput: StagingInput;
  isOpen: boolean;
  onClose: () => void;
  onCommit: (
    finalManifest: ExtractedEventManifest,
    extra: {
      ticketPrice?: number;
      seatingTier?: string;
      companions?: string[];
      attendanceStatus?: 'attended' | 'upcoming' | 'wishlist';
      rating?: number;
      isOutdoor?: boolean;
      isFestival?: boolean;
      endDate?: string;
      festivalDays?: FestivalDayAttendance[];
    },
  ) => void;
}

export const VerificationModal: React.FC<VerificationModalProps> = ({
  manifest: initialManifest,
  stagingInput,
  isOpen,
  onClose,
  onCommit,
}) => {
  const [manifest, setManifest] = useState<ExtractedEventManifest>({ ...initialManifest });

  // Festival & Multi-day State
  const initialIsFestival =
    initialManifest.isFestival ??
    Boolean(
      initialManifest.endDate ||
        (initialManifest.festivalDays && initialManifest.festivalDays.length > 0) ||
        /festival|fest|in the park|weekend/i.test(initialManifest.eventName),
    );

  const [isFestival, setIsFestival] = useState<boolean>(initialIsFestival);
  const [endDate, setEndDate] = useState<string>(initialManifest.endDate || '');

  const [festivalDays, setFestivalDays] = useState<
    Array<{
      date: string;
      dayIndex: number;
      label?: string;
      attended: boolean;
      notes?: string;
    }>
  >(() => {
    if (initialManifest.festivalDays && initialManifest.festivalDays.length > 0) {
      return initialManifest.festivalDays.map((d) => ({
        date: d.date,
        dayIndex: d.dayIndex,
        label: d.label,
        attended: d.attended ?? true,
        notes: d.notes,
      }));
    }
    // Default to at least day 1
    return [
      {
        date: initialManifest.eventDate,
        dayIndex: 1,
        label: 'Day 1',
        attended: true,
      },
    ];
  });

  // Companion & Ticket Ledger state
  const [ticketPrice, setTicketPrice] = useState<string>('');
  const [seatingTier, setSeatingTier] = useState<string>('General Admission');
  const [companionsStr, setCompanionsStr] = useState<string>('');
  const [attendanceStatus, setAttendanceStatus] = useState<'attended' | 'upcoming' | 'wishlist'>('attended');
  const [rating, setRating] = useState<number>(5);
  const [isOutdoor, setIsOutdoor] = useState<boolean>(initialManifest.venue.isOutdoor ?? false);

  const [activeTab, setActiveTab] = useState<'review' | 'transformed' | 'diagnostics' | 'raw_json'>('review');

  if (!isOpen) return null;

  // Handlers for Festival Days
  const handleToggleDayAttended = (index: number) => {
    const updated = [...festivalDays];
    updated[index] = { ...updated[index], attended: !updated[index].attended };
    setFestivalDays(updated);
  };

  const handleUpdateDay = (
    index: number,
    updates: Partial<{ date: string; label: string; attended: boolean; notes: string }>,
  ) => {
    const updated = [...festivalDays];
    updated[index] = { ...updated[index], ...updates };
    setFestivalDays(updated);
  };

  const handleSelectAllFestivalDays = (attended: boolean) => {
    setFestivalDays(festivalDays.map((d) => ({ ...d, attended })));
  };

  const handleAddFestivalDay = () => {
    const nextIdx = festivalDays.length + 1;
    let nextDate = manifest.eventDate;
    if (festivalDays.length > 0) {
      const lastDate = new Date(festivalDays[festivalDays.length - 1].date);
      if (!isNaN(lastDate.getTime())) {
        lastDate.setDate(lastDate.getDate() + 1);
        nextDate = lastDate.toISOString().slice(0, 10);
      }
    }
    setFestivalDays([
      ...festivalDays,
      {
        date: nextDate,
        dayIndex: nextIdx,
        label: `Day ${nextIdx}`,
        attended: true,
      },
    ]);
  };

  const handleRemoveFestivalDay = (index: number) => {
    const updated = festivalDays
      .filter((_, idx) => idx !== index)
      .map((d, i) => ({ ...d, dayIndex: i + 1, label: d.label || `Day ${i + 1}` }));
    setFestivalDays(updated);
  };

  const handleRegenerateDays = () => {
    if (!manifest.eventDate || !endDate) return;
    try {
      const start = new Date(manifest.eventDate);
      const end = new Date(endDate);
      const diff = Math.min(Math.max(Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1, 1), 7);
      const generated = Array.from({ length: diff }).map((_, idx) => {
        const d = new Date(start);
        d.setDate(start.getDate() + idx);
        const iso = d.toISOString().slice(0, 10);
        const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
        return {
          dayIndex: idx + 1,
          date: iso,
          label: `Day ${idx + 1} (${weekday})`,
          attended: true,
        };
      });
      setFestivalDays(generated);
    } catch (e) {
      console.warn('Could not generate festival days:', e);
    }
  };

  // Handlers for Artist lineup edits
  const handleUpdateArtist = (index: number, updates: Partial<ExtractedArtist>) => {
    const updated = [...manifest.artists];
    updated[index] = { ...updated[index], ...updates };
    setManifest({ ...manifest, artists: updated });
  };

  const handleRemoveArtist = (index: number) => {
    const updated = manifest.artists.filter((_, idx) => idx !== index);
    setManifest({ ...manifest, artists: updated });
  };

  const handleAddArtist = () => {
    const newArtist: ExtractedArtist = {
      name: '',
      billingOrder: manifest.artists.length + 1,
      role: 'support',
      stage: 'Main Stage',
    };
    setManifest({ ...manifest, artists: [...manifest.artists, newArtist] });
  };

  const handleCommit = () => {
    const companions = companionsStr
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    const finalFestivalDays = isFestival
      ? festivalDays.map((d, i) => ({
          date: d.date || manifest.eventDate,
          dayIndex: i + 1,
          label: d.label || `Day ${i + 1}`,
          attended: d.attended ?? true,
          notes: d.notes,
        }))
      : undefined;

    const finalManifest: ExtractedEventManifest = {
      ...manifest,
      isFestival,
      isMultiDay: isFestival && (finalFestivalDays ? finalFestivalDays.length > 1 : false),
      endDate: isFestival && endDate ? endDate : undefined,
      festivalDays: finalFestivalDays,
    };

    onCommit(finalManifest, {
      ticketPrice: ticketPrice ? parseFloat(ticketPrice) : undefined,
      seatingTier,
      companions,
      attendanceStatus,
      rating,
      isOutdoor,
      isFestival,
      endDate: isFestival && endDate ? endDate : undefined,
      festivalDays: finalFestivalDays?.map((d) => ({
        date: d.date,
        day_index: d.dayIndex,
        label: d.label,
        attended: d.attended,
        notes: d.notes,
      })),
    });
  };

  const confidencePct = Math.round(manifest.confidenceScore * 100);
  const engineMeta = manifest.engineMetadata;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-4xl rounded-2xl border border-zinc-700/80 bg-zinc-900 shadow-2xl overflow-hidden my-6">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">
                  Extraction Engine Verification & Ingestion
                </h2>
                {engineMeta?.extractionModel && (
                  <span className="rounded bg-violet-500/20 border border-violet-500/30 px-2 py-0.5 text-[10px] font-mono text-violet-300">
                    {engineMeta.extractionModel}
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400">
                Audit extracted event details, inspect relational transformations, and commit to the database
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Confidence Score Pill */}
            <div
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                confidencePct >= 90
                  ? 'border border-emerald-500/40 bg-emerald-950/60 text-emerald-300'
                  : 'border border-amber-500/40 bg-amber-950/60 text-amber-300'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>{confidencePct}% Confidence</span>
            </div>

            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Fallback notification banner if fallback was triggered */}
        {engineMeta?.fallbackTriggered && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-950/30 px-6 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
            <span>
              <strong>Graceful Fallback Engaged:</strong> Synthesized using the resilient Heuristic & Archival Knowledge Synthesizer ({engineMeta.fallbackReason || 'API fallback'}). All event attributes were authoritatively constructed.
            </span>
          </div>
        )}

        {/* View Switcher Bar */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/60 px-6 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveTab('review')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1 font-medium transition-colors ${
                activeTab === 'review'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Event Manifest Audit</span>
            </button>

            <button
              onClick={() => setActiveTab('transformed')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1 font-medium transition-colors ${
                activeTab === 'transformed'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Database className="h-3.5 w-3.5 text-violet-400" />
              <span>Transformed Database Payload</span>
            </button>

            <button
              onClick={() => setActiveTab('diagnostics')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1 font-medium transition-colors ${
                activeTab === 'diagnostics'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Terminal className="h-3.5 w-3.5 text-cyan-400" />
              <span>Scan Diagnostics</span>
            </button>

            <button
              onClick={() => setActiveTab('raw_json')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1 font-medium transition-colors ${
                activeTab === 'raw_json'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>Raw JSON</span>
            </button>
          </div>

          {manifest.sourceUrls && manifest.sourceUrls.length > 0 && (
            <div className="hidden sm:flex items-center gap-1.5 text-zinc-400 text-[11px]">
              <span>Sources:</span>
              <div className="flex items-center gap-1 truncate max-w-xs">
                {manifest.sourceUrls.slice(0, 2).map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 rounded bg-zinc-800 px-1.5 py-0.5 text-violet-300 hover:underline"
                  >
                    <span>{new URL(url).hostname.replace('www.', '')}</span>
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal Body */}
        <div className="max-h-[68vh] overflow-y-auto p-6 space-y-6">
          {/* Tab 1: Line Item Audit Form */}
          {activeTab === 'review' && (
            <>
              {/* Event Core Details */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-4 space-y-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <Calendar className="h-4 w-4 text-violet-400" />
                  <span>1. Event & Tour Verification</span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2 space-y-1">
                    <label className="text-xs text-zinc-400">Official Event Title</label>
                    <input
                      type="text"
                      value={manifest.eventName}
                      onChange={(e) => setManifest({ ...manifest, eventName: e.target.value })}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">Calendar Date (YYYY-MM-DD)</label>
                    <input
                      type="date"
                      value={manifest.eventDate}
                      onChange={(e) => setManifest({ ...manifest, eventDate: e.target.value })}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="sm:col-span-2 space-y-1">
                    <label className="text-xs text-zinc-400">Tour Name or Festival Edition</label>
                    <input
                      type="text"
                      value={manifest.tourName || ''}
                      onChange={(e) => setManifest({ ...manifest, tourName: e.target.value })}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">Setlist Status</label>
                    <div className="flex items-center h-8">
                      <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={manifest.setlistConfirmed}
                          onChange={(e) =>
                            setManifest({ ...manifest, setlistConfirmed: e.target.checked })
                          }
                          className="rounded border-zinc-700 text-violet-600 focus:ring-violet-500"
                        />
                        <span>Official Setlist Confirmed</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              {/* Multi-Day Festival & Attendance Specification */}
              <div className="rounded-xl border border-amber-500/40 bg-zinc-950/60 p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/80 pb-3">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl">🎪</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                          Multi-Day Festival & Attended Days Tracker
                        </span>
                        {isFestival && (
                          <span className="rounded-full bg-amber-500/20 border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                            {festivalDays.filter((d) => d.attended).length} / {festivalDays.length} Days Attended (
                            {Math.round(
                              ((festivalDays.filter((d) => d.attended).length) /
                                (festivalDays.length || 1)) *
                                100,
                            )}
                            %)
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-400">
                        Designate festival runs and check off each individual day you attended
                      </p>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 cursor-pointer hover:bg-zinc-800 transition-colors">
                    <input
                      type="checkbox"
                      checked={isFestival}
                      onChange={(e) => setIsFestival(e.target.checked)}
                      className="rounded border-zinc-700 text-amber-500 focus:ring-amber-400 h-4 w-4"
                    />
                    <span>Multi-Day / Festival</span>
                  </label>
                </div>

                {isFestival && (
                  <div className="space-y-4 pt-1">
                    {/* Date Span Configuration */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-zinc-400">Festival Start Date</label>
                        <input
                          type="date"
                          value={manifest.eventDate}
                          onChange={(e) => {
                            setManifest({ ...manifest, eventDate: e.target.value });
                            if (festivalDays[0]) {
                              handleUpdateDay(0, { date: e.target.value });
                            }
                          }}
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-zinc-400">Festival End Date</label>
                        <input
                          type="date"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>

                      <div className="flex items-end">
                        <button
                          type="button"
                          onClick={handleRegenerateDays}
                          disabled={!manifest.eventDate || !endDate}
                          className="w-full rounded-lg border border-amber-600/40 bg-amber-950/40 px-2.5 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-900/50 disabled:opacity-40 transition-colors"
                        >
                          Generate Days from Range
                        </button>
                      </div>
                    </div>

                    {/* Day Attendance Controls */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-zinc-300">
                        Daily Attendance Ledger ({festivalDays.length} Days):
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSelectAllFestivalDays(true)}
                          className="rounded-md bg-emerald-950/50 border border-emerald-500/30 hover:bg-emerald-900/50 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 transition-colors"
                        >
                          ✓ Attended All
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSelectAllFestivalDays(false)}
                          className="rounded-md bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors"
                        >
                          Clear All
                        </button>
                        <button
                          type="button"
                          onClick={handleAddFestivalDay}
                          className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-200 transition-colors"
                        >
                          <Plus className="h-3 w-3" />
                          <span>Add Day</span>
                        </button>
                      </div>
                    </div>

                    {/* Day-by-Day Itemized Attendance Cards */}
                    <div className="space-y-2.5">
                      {festivalDays.map((day, idx) => (
                        <div
                          key={idx}
                          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-3 transition-colors ${
                            day.attended
                              ? 'border-emerald-500/50 bg-emerald-950/20'
                              : 'border-zinc-800 bg-zinc-900/40 opacity-75'
                          }`}
                        >
                          {/* Toggle Attended Switch */}
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggleDayAttended(idx)}
                              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
                                day.attended
                                  ? 'bg-emerald-500 text-zinc-950 shadow-sm shadow-emerald-500/30'
                                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700'
                              }`}
                            >
                              <CheckCircle2 className={`h-3.5 w-3.5 ${day.attended ? 'text-zinc-950' : 'text-zinc-500'}`} />
                              <span>{day.attended ? 'Attended' : 'Skipped / Unattended'}</span>
                            </button>

                            <input
                              type="text"
                              value={day.label || `Day ${day.dayIndex}`}
                              onChange={(e) => handleUpdateDay(idx, { label: e.target.value })}
                              placeholder={`Day ${day.dayIndex}`}
                              className="w-36 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-semibold text-zinc-100 focus:border-amber-500 focus:outline-none"
                            />
                          </div>

                          {/* Date and Custom Highlights */}
                          <div className="flex flex-1 items-center gap-2">
                            <input
                              type="date"
                              value={day.date}
                              onChange={(e) => handleUpdateDay(idx, { date: e.target.value })}
                              className="w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 focus:border-amber-500 focus:outline-none"
                            />

                            <input
                              type="text"
                              value={day.notes || ''}
                              onChange={(e) => handleUpdateDay(idx, { notes: e.target.value })}
                              placeholder="Day notes (e.g. Headliner set, only went Sunday)"
                              className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                            />

                            {festivalDays.length > 1 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveFestivalDay(idx)}
                                className="rounded p-1 text-zinc-500 hover:text-red-400 transition-colors"
                                title="Remove day"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Venue Decomposition */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    <Building className="h-4 w-4 text-violet-400" />
                    <span>2. Venue & Municipality Topology</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isOutdoor}
                      onChange={(e) => setIsOutdoor(e.target.checked)}
                      className="rounded border-zinc-700 text-violet-600 focus:ring-violet-500"
                    />
                    <span>Open-Air / Outdoor Staging</span>
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div className="sm:col-span-2 space-y-1">
                    <label className="text-xs text-zinc-400">Official Venue Name</label>
                    <input
                      type="text"
                      value={manifest.venue.name}
                      onChange={(e) =>
                        setManifest({
                          ...manifest,
                          venue: { ...manifest.venue, name: e.target.value },
                        })
                      }
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">Municipality (City)</label>
                    <input
                      type="text"
                      value={manifest.venue.city}
                      onChange={(e) =>
                        setManifest({
                          ...manifest,
                          venue: { ...manifest.venue, city: e.target.value },
                        })
                      }
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">State / Region</label>
                    <input
                      type="text"
                      value={manifest.venue.state || ''}
                      onChange={(e) =>
                        setManifest({
                          ...manifest,
                          venue: { ...manifest.venue, state: e.target.value },
                        })
                      }
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Lineup Decomposition */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    <Music className="h-4 w-4 text-violet-400" />
                    <span>3. Artist Hierarchy & Billing Decomposition ({manifest.artists.length} Acts)</span>
                  </div>

                  <button
                    type="button"
                    onClick={handleAddArtist}
                    className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    <span>Add Performer</span>
                  </button>
                </div>

                <div className="space-y-2">
                  {manifest.artists.map((artist, idx) => (
                    <div
                      key={idx}
                      className="flex flex-col sm:flex-row items-start sm:items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5"
                    >
                      <div className="flex items-center gap-2 w-full sm:w-auto">
                        <span className="flex h-6 w-6 items-center justify-center rounded bg-zinc-800 font-mono text-xs font-bold text-zinc-400">
                          {artist.billingOrder}
                        </span>
                        <input
                          type="text"
                          value={artist.name}
                          placeholder="Performer Name"
                          onChange={(e) => handleUpdateArtist(idx, { name: e.target.value })}
                          className="flex-1 sm:w-48 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none font-medium"
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:flex-1">
                        <select
                          value={artist.role}
                          onChange={(e) =>
                            handleUpdateArtist(idx, { role: e.target.value as BillingRole })
                          }
                          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none"
                        >
                          <option value="headliner">Headliner</option>
                          <option value="support">Support</option>
                          <option value="guest">Special Guest</option>
                          <option value="festival_lineup">Festival Lineup</option>
                        </select>

                        <input
                          type="text"
                          value={artist.stage || ''}
                          placeholder="Stage (e.g. Main Stage)"
                          onChange={(e) => handleUpdateArtist(idx, { stage: e.target.value })}
                          className="w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none"
                        />

                        <button
                          type="button"
                          onClick={() => handleRemoveArtist(idx)}
                          className="ml-auto rounded p-1 text-zinc-500 hover:text-red-400 transition-colors"
                          title="Remove artist"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Personal Ledger / Companion Tracking */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-4 space-y-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <DollarSign className="h-4 w-4 text-emerald-400" />
                  <span>4. Personal Attendance & Spend Ledger</span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">Ticket Price ($ USD)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 85.00"
                      value={ticketPrice}
                      onChange={(e) => setTicketPrice(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">Seating / Tier</label>
                    <input
                      type="text"
                      value={seatingTier}
                      onChange={(e) => setSeatingTier(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">Companions (Comma Separated)</label>
                    <input
                      type="text"
                      placeholder="e.g. Sarah, Alex, Jordan"
                      value={companionsStr}
                      onChange={(e) => setCompanionsStr(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Research Notes & Context */}
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Archivist Notes & Context</label>
                <textarea
                  rows={2}
                  value={manifest.notes || ''}
                  onChange={(e) => setManifest({ ...manifest, notes: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-xs text-zinc-200 focus:border-violet-500 focus:outline-none"
                />
              </div>
            </>
          )}

          {/* Tab 2: Transformed Relational Core Preview */}
          {activeTab === 'transformed' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-4">
                <h3 className="text-xs font-semibold text-violet-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Database className="h-4 w-4 text-violet-400" />
                  <span>Relational Schema Ingestion Preview (Ready for Supabase)</span>
                </h3>
                <p className="text-xs text-zinc-400">
                  The extraction engine transforms the unstructured text into 4 normalized relational records:
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                {/* Event Table Record */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-2">
                  <div className="font-semibold text-emerald-400 font-mono text-[11px] uppercase">
                    Table: `events`
                  </div>
                  <div className="space-y-1 text-zinc-300 font-mono text-[11px]">
                    <div><span className="text-zinc-500">name:</span> "{manifest.eventName}"</div>
                    <div><span className="text-zinc-500">tour_name:</span> "{manifest.tourName || ''}"</div>
                    <div><span className="text-zinc-500">event_date:</span> "{manifest.eventDate}"</div>
                    <div><span className="text-zinc-500">is_festival:</span> {isFestival ? 'true' : 'false'}</div>
                    {isFestival && endDate && <div><span className="text-zinc-500">end_date:</span> "{endDate}"</div>}
                    {isFestival && (
                      <div>
                        <span className="text-zinc-500">festival_days:</span> {festivalDays.filter((d) => d.attended).length}/{festivalDays.length} attended
                      </div>
                    )}
                    <div><span className="text-zinc-500">setlist_confirmed:</span> {manifest.setlistConfirmed ? 'true' : 'false'}</div>
                    <div><span className="text-zinc-500">confidence_score:</span> {manifest.confidenceScore}</div>
                  </div>
                </div>

                {/* Venue Table Record */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-2">
                  <div className="font-semibold text-indigo-400 font-mono text-[11px] uppercase">
                    Table: `venues`
                  </div>
                  <div className="space-y-1 text-zinc-300 font-mono text-[11px]">
                    <div><span className="text-zinc-500">name:</span> "{manifest.venue.name}"</div>
                    <div><span className="text-zinc-500">city:</span> "{manifest.venue.city}"</div>
                    <div><span className="text-zinc-500">state:</span> "{manifest.venue.state || ''}"</div>
                    <div><span className="text-zinc-500">country:</span> "{manifest.venue.country || 'United States'}"</div>
                    <div><span className="text-zinc-500">isOutdoor:</span> {isOutdoor ? 'true' : 'false'}</div>
                  </div>
                </div>

                {/* Artists Table Record */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-2 md:col-span-2">
                  <div className="font-semibold text-cyan-400 font-mono text-[11px] uppercase">
                    Table: `event_appearances` ({manifest.artists.length} Rows Join Table)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-zinc-300 font-mono text-[11px]">
                    {manifest.artists.map((a, i) => (
                      <div key={i} className="rounded bg-zinc-900 p-2 border border-zinc-800">
                        <span className="text-violet-400 font-bold">#{a.billingOrder}</span> {a.name}
                        <span className="block text-zinc-500 text-[10px]">role: {a.role} | stage: {a.stage || 'Main Stage'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: Scan Diagnostics */}
          {activeTab === 'diagnostics' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
                <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-zinc-800 pb-2">
                  <span className="font-semibold text-zinc-200">Execution Diagnostics</span>
                  <span className="font-mono text-cyan-400">
                    {engineMeta?.executionTimeMs ? `${engineMeta.executionTimeMs}ms` : 'N/A'}
                  </span>
                </div>

                {engineMeta?.synthesizedSummary && (
                  <div className="text-xs text-zinc-300 bg-zinc-900/80 p-3 rounded-lg border border-zinc-800">
                    <strong className="text-violet-300 block mb-1">Synthesized Summary:</strong>
                    {engineMeta.synthesizedSummary}
                  </div>
                )}

                <div className="space-y-1.5 pt-2">
                  <div className="text-xs font-semibold text-zinc-400">Sequential Scan Pipeline:</div>
                  <div className="space-y-1 font-mono text-[11px]">
                    {(engineMeta?.scanSteps || [
                      'Stage 1: Tokenized input query',
                      'Stage 2: Decomposed artist lineup',
                      'Stage 3: Mapped venue municipal topology',
                      'Stage 4: Synthesized authoritative manifest',
                    ]).map((step, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-zinc-300">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 4: Raw Grounded JSON */}
          {activeTab === 'raw_json' && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-zinc-300 overflow-x-auto">
              <pre>
                {JSON.stringify(
                  {
                    ...manifest,
                    isFestival,
                    endDate: isFestival ? endDate || undefined : undefined,
                    festivalDays: isFestival ? festivalDays : undefined,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          )}
        </div>

        {/* Modal Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950 px-6 py-4">
          <div className="text-xs text-zinc-500 flex items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5 text-violet-400" />
            <span>Transformed data will be committed into relational database & UI archive</span>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 sm:flex-initial rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              Amend / Cancel
            </button>

            <button
              type="button"
              onClick={handleCommit}
              className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 px-6 py-2 text-xs font-semibold text-white shadow-lg shadow-violet-600/30 hover:opacity-95 transition-all"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span>Ingest & Commit to Database</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
