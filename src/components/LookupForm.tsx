import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Database, Loader2, RefreshCw, Search, XCircle } from 'lucide-react';
import { isActive, LineupStatus, lineupApi, LookupInput, LookupJob, SOURCE_LABELS } from '../services/lineupApi';

interface LookupFormProps {
  onReview: (job: LookupJob) => void;
}

const EMPTY: Partial<LookupInput> & { year: number | '' } = {
  eventName: '',
  year: new Date().getFullYear(),
  startDate: '',
  endDate: '',
  venue: '',
  city: '',
  lineupUrl: '',
  notes: '',
};

const STATUS_LABEL: Record<LookupJob['status'], string> = {
  queued: 'Queued',
  running: 'Looking up',
  waiting_quota: 'Waiting for capacity',
  needs_review: 'Ready to review',
  no_data: 'No lineup found',
  confirmed: 'Saved',
  failed: 'Failed',
};

function StatusBadge({ job }: { job: LookupJob }) {
  const tone =
    job.status === 'needs_review' || job.status === 'confirmed'
      ? 'border-emerald-500/40 text-emerald-300'
      : job.status === 'waiting_quota'
        ? 'border-amber-500/40 text-amber-300'
        : job.status === 'failed' || job.status === 'no_data'
          ? 'border-rose-500/40 text-rose-300'
          : 'border-violet-500/40 text-violet-300';
  const Icon =
    job.status === 'needs_review' || job.status === 'confirmed'
      ? CheckCircle2
      : job.status === 'waiting_quota'
        ? Clock
        : job.status === 'failed' || job.status === 'no_data'
          ? XCircle
          : Loader2;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      <Icon className={`h-3 w-3 ${isActive(job) ? 'animate-spin' : ''}`} />
      {STATUS_LABEL[job.status]}
    </span>
  );
}

const field =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';

export const LookupForm: React.FC<LookupFormProps> = ({ onReview }) => {
  const [form, setForm] = useState(EMPTY);
  const [jobs, setJobs] = useState<LookupJob[]>([]);
  const [status, setStatus] = useState<LineupStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([lineupApi.list(), lineupApi.status()]);
      setJobs(list);
      setStatus(st);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while anything is in flight.
  useEffect(() => {
    if (!jobs.some(isActive)) return;
    const t = setTimeout(() => void refresh(), 1500);
    return () => clearTimeout(t);
  }, [jobs, refresh]);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: k === 'year' ? (e.target.value ? Number(e.target.value) : '') : e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const job = await lineupApi.create({ ...form, year: Number(form.year) });
      setSelectedId(job.id);
      await refresh();
      if (job.status === 'needs_review' && job.candidate?.cached) onReview(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (job: LookupJob) => {
    await lineupApi.retry(job.id);
    setTimeout(() => void refresh(), 500);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-white">Add an event</h1>
        <p className="text-sm text-zinc-400">
          Lineups come from Clashfinder, the promoter's own page and ticketing listings. Gemini only reads pages the app
          fetched, and every name must appear on that page. If there's no capacity, the lookup waits instead of guessing.
        </p>
        {status && (
          <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
            {status.sources.map((s) => (
              <span
                key={s.id}
                className={`rounded-full border px-2 py-0.5 ${s.enabled ? 'border-emerald-500/30 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}
                title={s.enabled ? 'Configured' : 'Not configured; see .env.example'}
              >
                {SOURCE_LABELS[s.id]}
                {s.enabled ? '' : ' (off)'}
              </span>
            ))}
            <span className={`rounded-full border px-2 py-0.5 ${status.gemini ? 'border-emerald-500/30 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>
              Gemini {status.gemini ? `${status.quota?.used ?? 0}/${status.quota?.limit ?? '?'} today` : '(off)'}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-400">
              <Database className="h-3 w-3" /> {status.store === 'supabase' ? 'Supabase' : 'Local file store'}
            </span>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="grid grid-cols-1 gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-5 sm:grid-cols-6">
        <label className="sm:col-span-4 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">Event or festival *</span>
          <input className={field} value={form.eventName} onChange={set('eventName')} placeholder="EDC Las Vegas" required />
        </label>
        <label className="sm:col-span-2 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">Year *</span>
          <input className={field} type="number" value={form.year} onChange={set('year')} min={1950} max={2100} required />
        </label>
        <label className="sm:col-span-2 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">Start date</span>
          <input className={field} type="date" value={form.startDate} onChange={set('startDate')} />
        </label>
        <label className="sm:col-span-2 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">End date</span>
          <input className={field} type="date" value={form.endDate} onChange={set('endDate')} />
        </label>
        <label className="sm:col-span-2 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">City</span>
          <input className={field} value={form.city} onChange={set('city')} placeholder="Las Vegas" />
        </label>
        <label className="sm:col-span-3 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">Venue</span>
          <input className={field} value={form.venue} onChange={set('venue')} placeholder="Las Vegas Motor Speedway" />
        </label>
        <label className="sm:col-span-3 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">Lineup URL (promoter page or Clashfinder)</span>
          <input className={field} type="url" value={form.lineupUrl} onChange={set('lineupUrl')} placeholder="https://..." />
        </label>
        <label className="sm:col-span-6 space-y-1">
          <span className="text-xs font-semibold text-zinc-400">Notes</span>
          <textarea className={field} rows={2} value={form.notes} onChange={set('notes')} />
        </label>
        <div className="sm:col-span-6 flex items-center justify-between gap-3">
          {error ? <p className="text-sm text-rose-300">{error}</p> : <span />}
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Find lineup
          </button>
        </div>
      </form>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2 space-y-2">
          <h2 className="text-sm font-semibold text-zinc-300">Recent lookups</h2>
          {jobs.length === 0 && <p className="text-sm text-zinc-500">Nothing yet.</p>}
          {jobs.map((job) => (
            <button
              key={job.id}
              onClick={() => setSelectedId(job.id)}
              className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedId === job.id ? 'border-violet-500/60 bg-zinc-900' : 'border-zinc-800 bg-zinc-950 hover:bg-zinc-900'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-zinc-100">
                  {job.input.eventName} {job.input.year}
                </span>
                <StatusBadge job={job} />
              </div>
              {job.waitingReason && <p className="mt-1 text-xs text-amber-300/80">{job.waitingReason}</p>}
            </button>
          ))}
        </div>

        <div className="lg:col-span-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
          {!selected ? (
            <p className="text-sm text-zinc-500">Select a lookup to see what each source found.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white">
                  {selected.input.eventName} {selected.input.year}
                </h3>
                <StatusBadge job={selected} />
              </div>
              {selected.status === 'waiting_quota' && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-950/30 p-3 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-2">
                    <p>
                      {selected.waitingReason} It will retry automatically
                      {selected.nextAttemptAt ? ` after ${new Date(selected.nextAttemptAt).toLocaleString()}` : ''}.
                      Results from the other sources are kept.
                    </p>
                    <button onClick={() => retry(selected)} className="inline-flex items-center gap-1 font-semibold text-amber-100 hover:underline">
                      <RefreshCw className="h-3 w-3" /> Try now
                    </button>
                  </div>
                </div>
              )}
              {selected.status === 'failed' && (
                <button onClick={() => retry(selected)} className="inline-flex items-center gap-1 text-xs font-semibold text-rose-200 hover:underline">
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              )}
              {(selected.status === 'needs_review' || selected.status === 'no_data') && (
                <button
                  onClick={() => onReview(selected)}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  {selected.status === 'no_data' ? 'Enter the lineup by hand' : `Review ${selected.candidate?.performers.length ?? 0} acts`}
                </button>
              )}
              <ol className="max-h-80 space-y-1 overflow-y-auto font-mono text-[11px] text-zinc-400">
                {selected.log.map((entry, i) => (
                  <li key={i}>
                    <span className="text-zinc-600">{new Date(entry.at).toLocaleTimeString()}</span> {entry.message}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
