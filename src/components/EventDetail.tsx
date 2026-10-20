import React, { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2, RefreshCw, Search, Star, Trash2, X } from 'lucide-react';
import {
  DetailCandidate,
  Edition,
  EventPatch,
  eventsApi,
  isActive,
  lineupApi,
  LoggedEvent,
  LookupJob,
  SOURCE_LABELS,
} from '../services/lineupApi';
import { datesBetween, whenLabel } from '../services/format';
import { LineupReview } from './LineupReview';

interface EventDetailProps {
  event: LoggedEvent;
  onChange: (event: LoggedEvent) => void;
  onDeleted: () => void;
  onClose: () => void;
}

const input =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-500';

// A text field that saves when you leave it.
const Field: React.FC<{
  label: string;
  value?: string | number;
  type?: string;
  placeholder?: string;
  source?: LoggedEvent['sources'][keyof LoggedEvent['sources']];
  onSave: (value: string) => void;
  className?: string;
}> = ({ label, value, type = 'text', placeholder, source, onSave, className }) => {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  return (
    <label className={`space-y-1 ${className ?? ''}`}>
      <span className="flex items-center justify-between gap-2 text-[11px] font-semibold text-zinc-400">
        {label}
        {source && source.sourceType !== 'user' && (
          <a
            href={source.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 font-normal text-zinc-500 hover:text-violet-300"
          >
            via {SOURCE_LABELS[source.sourceType]} <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </span>
      <input
        className={input}
        type={type}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== (value === undefined ? '' : String(value)) && onSave(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
};

// Chips with an input to add more (seen acts, companions).
const ChipInput: React.FC<{
  items: string[];
  placeholder: string;
  onChange: (items: string[]) => void;
}> = ({ items, placeholder, onChange }) => {
  const [draft, setDraft] = useState('');
  const add = () => {
    const names = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length) onChange([...items, ...names]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 p-1.5">
      {items.map((item, i) => (
        <span key={`${item}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-zinc-800 py-1 pl-2.5 pr-1.5 text-sm text-zinc-100">
          {item}
          <button onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${item}`} className="text-zinc-500 hover:text-zinc-200">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={placeholder}
        className="min-w-[8rem] flex-1 bg-transparent px-1.5 py-1 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
      />
    </div>
  );
};

function candidateLine(c: DetailCandidate): string {
  return [whenLabel(c), c.venue, c.city, c.country].filter(Boolean).join(' · ');
}

const JOB_STATUS: Record<LookupJob['status'], string> = {
  queued: 'Waiting to start',
  running: 'Looking through sources',
  waiting_quota: 'Waiting for capacity',
  needs_review: 'Ready to review',
  no_data: 'No source listed a lineup',
  confirmed: 'Confirmed',
  failed: 'Failed',
};

export const EventDetail: React.FC<EventDetailProps> = ({ event, onChange, onDeleted, onClose }) => {
  const [job, setJob] = useState<LookupJob | null>(null);
  const [edition, setEdition] = useState<Edition | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineupUrl, setLineupUrl] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await eventsApi.get(event.id);
      setJob(data.job);
      setEdition(data.edition);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [event.id]);

  useEffect(() => {
    void load();
  }, [load, event.lineupJobId, event.editionId]);

  useEffect(() => {
    if (!isActive(job?.status)) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [job, load]);

  const run = async (label: string, fn: () => Promise<LoggedEvent | void>) => {
    setBusy(label);
    setError(null);
    try {
      const updated = await fn();
      if (updated) onChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const save = (patch: EventPatch) => run('save', () => eventsApi.update(event.id, patch));
  const text = (v: string) => (v.trim() ? v.trim() : null);

  const seenKeys = new Set(event.seen.map((s) => s.key));
  const lineupActs = (edition?.performances ?? []).filter((p) => p.status !== 'cancelled');
  const days = datesBetween(event.startDate, event.endDate);
  const details = event.details;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl space-y-6 overflow-y-auto border-l border-zinc-900 bg-zinc-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <Field label="Event" value={event.name} onSave={(v) => save({ name: v })} className="flex-1" />
          <button onClick={onClose} className="mt-6 text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {event.input && event.input !== event.name && <p className="-mt-4 text-xs text-zinc-600">You typed: “{event.input}”</p>}
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}

        {/* Stage 1: when and where */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className={sectionTitle}>When and where</h3>
            <button
              onClick={() => run('research', () => eventsApi.research(event.id))}
              disabled={busy === 'research'}
              className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
            >
              {busy === 'research' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Look again
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" type="date" value={event.startDate} source={event.sources.startDate} onSave={(v) => save({ startDate: text(v) })} />
            <Field label="Last day (multi-day)" type="date" value={event.endDate} source={event.sources.endDate} onSave={(v) => save({ endDate: text(v) })} />
            {!event.startDate && (
              <Field label="Year, if that's all you know" type="number" value={event.year} placeholder="2024" onSave={(v) => save({ year: v ? Number(v) : null })} />
            )}
            <Field label="Venue" value={event.venue} source={event.sources.venue} onSave={(v) => save({ venue: text(v) })} />
            <Field label="City" value={event.city} source={event.sources.city} onSave={(v) => save({ city: text(v) })} />
            <Field label="Country" value={event.country} source={event.sources.country} onSave={(v) => save({ country: text(v) })} />
          </div>

          {details.status === 'choose' && (
            <div className="space-y-2 rounded-xl border border-violet-500/30 bg-violet-950/20 p-3">
              <p className="text-sm text-violet-200">Is it one of these?</p>
              {details.candidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => run('pick', () => eventsApi.pick(event.id, c.id))}
                  className="flex w-full items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-left hover:border-violet-500"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-100">{candidateLine(c) || c.name}</span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {c.name && `${c.name} · `}
                      {c.sources.map((s) => SOURCE_LABELS[s.sourceType]).join(', ')}
                    </span>
                  </span>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
                </button>
              ))}
              <button onClick={() => run('pick', () => eventsApi.pick(event.id))} className="text-xs text-zinc-400 hover:underline">
                None of these
              </button>
            </div>
          )}
          {details.status === 'matched' && <p className="text-xs text-emerald-300/80">Found a listing for that date and filled in what was missing.</p>}
          {details.status === 'none' && <p className="text-xs text-zinc-500">No listing found. It's saved as you typed it.</p>}
          {details.status === 'needs_date' && <p className="text-xs text-amber-300/90">Add when it was (a year is enough), then look again.</p>}
          {details.status === 'off' && <p className="text-xs text-zinc-500">No event source is set up, so details are as you typed them.</p>}
        </section>

        {/* Who you saw */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Who you saw</h3>
          <ChipInput
            items={event.seen.map((s) => s.name)}
            placeholder={event.seen.length ? 'Add another' : 'Type a name and press Enter'}
            onChange={(names) =>
              save({ seen: names.map((name) => ({ name, from: event.seen.find((s) => s.name === name)?.from ?? 'you' })) })
            }
          />
          {lineupActs.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-zinc-500">From the lineup, tap to mark who you saw:</p>
              <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                {lineupActs.map((p) => {
                  const on = seenKeys.has(p.artistKey);
                  return (
                    <button
                      key={p.artistKey}
                      onClick={() =>
                        save({
                          seen: on
                            ? event.seen.filter((s) => s.key !== p.artistKey)
                            : [...event.seen, { name: p.name, from: 'lineup' as const }],
                        })
                      }
                      className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* Stage 2: the lineup */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Full lineup</h3>
          {!job && !edition && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">
                Optional. The app looks for who played in Clashfinder, the promoter's page and ticketing listings, cites every act, and never guesses.
              </p>
              <input className={input} value={lineupUrl} onChange={(e) => setLineupUrl(e.target.value)} placeholder="Lineup page, if you know one (optional)" />
            </div>
          )}
          {edition && (
            <p className="text-sm text-zinc-300">
              {lineupActs.length} acts confirmed, each with a source.
            </p>
          )}
          {job && !edition && (
            <div className="space-y-2 rounded-xl border border-zinc-800 p-3">
              <div className="flex items-center gap-2 text-sm text-zinc-200">
                {isActive(job.status) && <Loader2 className="h-4 w-4 animate-spin text-violet-300" />}
                {JOB_STATUS[job.status]}
                {job.status === 'needs_review' && ` · ${job.candidate?.performers.length ?? 0} acts`}
              </div>
              {job.status === 'waiting_quota' && (
                <p className="text-xs text-amber-200/90">
                  {job.waitingReason} It continues on its own
                  {job.nextAttemptAt ? ` after ${new Date(job.nextAttemptAt).toLocaleString()}` : ''}; what was found so far is kept.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {(job.status === 'needs_review' || job.status === 'no_data') && (
                  <button onClick={() => setReviewing(true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">
                    {job.status === 'no_data' ? 'Enter acts by hand' : 'Review lineup'}
                  </button>
                )}
                {(job.status === 'waiting_quota' || job.status === 'failed') && (
                  <button
                    onClick={() =>
                      run('retry', async () => {
                        await lineupApi.retry(job.id);
                        setTimeout(() => void load(), 500);
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900"
                  >
                    <RefreshCw className="h-3 w-3" /> Try now
                  </button>
                )}
                <button onClick={() => setShowLog((s) => !s)} className="text-xs text-zinc-500 hover:text-zinc-300">
                  {showLog ? 'Hide' : 'Show'} what it did
                </button>
              </div>
              {showLog && (
                <ol className="max-h-60 space-y-1 overflow-y-auto font-mono text-[11px] text-zinc-500">
                  {job.log.map((entry, i) => (
                    <li key={i}>{entry.message}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {(!job || edition || job.status === 'no_data' || job.status === 'failed') && !isActive(job?.status) && (
            <button
              onClick={() => run('lineup', async () => (await eventsApi.findLineup(event.id, lineupUrl || undefined)).event)}
              disabled={busy === 'lineup' || !(event.year || event.startDate)}
              title={event.year || event.startDate ? undefined : 'Add when it was first'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/50 px-3 py-1.5 text-sm text-violet-200 hover:bg-violet-950/40 disabled:opacity-40"
            >
              {busy === 'lineup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {job ? 'Look up the lineup again' : 'Find who played'}
            </button>
          )}
        </section>

        {/* Your details */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Your notes</h3>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Went with</span>
            <ChipInput items={event.companions} placeholder="Add a name" onChange={(companions) => save({ companions })} />
          </label>
          {days.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
              <span className="font-semibold text-zinc-400">Days you went:</span>
              {days.map((d) => {
                const on = event.daysAttended.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => save({ daysAttended: on ? event.daysAttended.filter((x) => x !== d) : [...event.daysAttended, d].sort() })}
                    className={`rounded-full border px-2.5 py-1 ${on ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400'}`}
                  >
                    {new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-zinc-400">Rating</span>
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => save({ rating: event.rating === n ? null : n })} aria-label={`${n} stars`}>
                    <Star className={`h-5 w-5 ${event.rating && n <= event.rating ? 'fill-amber-400 text-amber-400' : 'text-zinc-700'}`} />
                  </button>
                ))}
              </div>
            </div>
            <Field
              label="Ticket price"
              type="number"
              value={event.ticketPrice}
              onSave={(v) => save({ ticketPrice: v ? Number(v) : null })}
              className="w-32"
            />
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Notes</span>
            <textarea
              className={input}
              rows={3}
              defaultValue={event.notes ?? ''}
              onBlur={(e) => e.target.value !== (event.notes ?? '') && save({ notes: text(e.target.value) })}
            />
          </label>
        </section>

        <div className="flex items-center justify-between border-t border-zinc-900 pt-4">
          <button
            onClick={() =>
              window.confirm(`Delete "${event.name}" from your log?`) &&
              run('delete', async () => {
                await eventsApi.remove(event.id);
                onDeleted();
              })
            }
            className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete event
          </button>
          {busy === 'save' && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
        </div>
      </div>

      {reviewing && job && (
        <LineupReview
          job={job}
          event={event}
          onClose={() => setReviewing(false)}
          onSaved={(updated) => {
            setReviewing(false);
            onChange(updated);
            void load();
          }}
        />
      )}
    </div>
  );
};
