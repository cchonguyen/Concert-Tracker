import React, { useEffect, useMemo, useState } from 'react';
import { Check, CloudSun, ExternalLink, Heart, Loader2, RefreshCw, Search, Star, X } from 'lucide-react';
import { eventsApi, lineupApi, LineupFacts, LineupSummary, LoggedEvent, LookupJob, EventPatch } from '../services/lineupApi';
import { whenLabel } from '../services/format';
import { canFindLineup, Gap, gapCounts, GAPS, hasGap } from '../services/table';

interface FillGapsProps {
  events: LoggedEvent[]; // the rows the Table shows
  all: LoggedEvent[]; // your whole log, for suggestions
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  onChanged: (event: LoggedEvent) => void;
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}

const GAP_LABELS: Record<Gap, string> = {
  date: 'Date',
  venue: 'Venue',
  city: 'City',
  type: 'Type',
  seen: 'Who you saw',
  favourite: 'Favourite set',
  review: 'Lineup to review',
  format: 'Format',
  companions: 'Went with',
  rating: 'Rating',
  price: 'Price',
  weather: 'Weather',
};

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';

function byCount(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const seenPatch = (e: LoggedEvent) => e.seen.map(({ name, from, role, roleFrom, favourite }) => ({ name, from, role, roleFrom, favourite }));

// One gap on one event: type the value and press Enter. Saving goes through
// the usual event edit, so every value is sourced as yours.
const GapEditor: React.FC<{
  event: LoggedEvent;
  gap: Gap;
  suggestions: string[];
  onSave: (patch: EventPatch) => Promise<void>;
}> = ({ event, gap, suggestions, onSave }) => {
  const [draft, setDraft] = useState('');
  const listId = React.useId();
  const submit = (patch: EventPatch | null) => {
    if (!patch) return;
    setDraft('');
    void onSave(patch);
  };
  const fromDraft = (): EventPatch | null => {
    const v = draft.trim();
    if (!v) return null;
    switch (gap) {
      case 'date':
        return /^\d{4}$/.test(v) ? { year: Number(v) } : { startDate: v };
      case 'venue':
        return { venue: v };
      case 'city':
        return { city: v };
      case 'format':
        return { format: v };
      case 'seen':
        return { seen: [...seenPatch(event), ...list(v).map((name) => ({ name, from: 'you' as const }))] };
      case 'companions':
        return { companions: [...event.companions, ...list(v)] };
      case 'price':
        return Number.isFinite(Number(v)) ? { ticketPrice: Number(v) } : null;
      default:
        return null;
    }
  };

  if (gap === 'type') {
    return (
      <div className="flex gap-1.5">
        {(['concert', 'festival'] as const).map((k) => (
          <button key={k} onClick={() => submit({ kind: k })} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:border-violet-500">
            {k === 'concert' ? 'Concert' : 'Festival'}
          </button>
        ))}
      </div>
    );
  }
  if (gap === 'favourite') {
    return (
      <div className="flex flex-wrap gap-1.5">
        {event.seen.map((s, i) => (
          <button
            key={s.key}
            onClick={() => submit({ seen: seenPatch(event).map((p, j) => ({ ...p, favourite: i === j })) })}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-amber-400"
          >
            <Heart className="h-3 w-3" /> {s.name}
          </button>
        ))}
      </div>
    );
  }
  if (gap === 'weather') return null;
  if (gap === 'rating') {
    return (
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => submit({ rating: n })} aria-label={`${n} stars`}>
            <Star className="h-5 w-5 text-zinc-600 hover:fill-amber-400 hover:text-amber-400" />
          </button>
        ))}
      </div>
    );
  }
  const placeholder: Partial<Record<Gap, string>> = {
    date: 'YYYY-MM-DD, or just the year',
    seen: 'Names, separated by commas',
    companions: 'Names, separated by commas',
    city: 'City, ST',
  };
  return (
    <>
      <input
        className={control}
        type={gap === 'date' ? 'text' : gap === 'price' ? 'number' : 'text'}
        value={draft}
        placeholder={placeholder[gap] ?? GAP_LABELS[gap]}
        list={suggestions.length ? listId : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit(fromDraft());
          }
        }}
        onBlur={() => submit(fromDraft())}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.slice(0, 200).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
};

// A lineup the lookup found, accepted in one tap: every act the sources agree
// on is kept (low-evidence ones are left out, not rejected), and acts you had
// already ticked stay ticked. "Open" shows the full review.
const ReviewRow: React.FC<{ event: LoggedEvent; onDone: (e: LoggedEvent) => void; onOpen: () => void }> = ({ event, onDone, onOpen }) => {
  const [job, setJob] = useState<LookupJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    eventsApi.get(event.id).then((d) => setJob(d.job), (err) => setError(String(err)));
  }, [event.id]);
  const acts = job?.candidate?.performers ?? [];
  const kept = acts.filter((p) => !p.flagged);
  const seen = new Set(event.seen.map((s) => s.key));
  const accept = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const { event: updated } = await lineupApi.confirm(job.id, {
        performers: kept.map((p) => ({ key: p.key, name: p.name, accepted: true, seen: seen.has(p.key) })),
      });
      if (updated) onDone(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  if (!job) return <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />;
  const head = kept.filter((p) => p.billing !== 'support');
  const support = kept.filter((p) => p.billing === 'support');
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-zinc-300">
        {head.slice(0, 8).map((p) => p.name).join(', ')}
        {head.length > 8 && ` +${head.length - 8} more`}
        {support.length > 0 && <span className="text-zinc-500"> · supporting: {support.map((p) => p.name).join(', ')}</span>}
      </p>
      {acts.length > kept.length && (
        <p className="text-[11px] text-amber-300/80">{acts.length - kept.length} low-evidence act(s) left out; open it to look at them.</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={accept}
          disabled={busy || !kept.length}
          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Accept {kept.length} act{kept.length === 1 ? '' : 's'}
        </button>
        <button onClick={onOpen} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-900">
          <ExternalLink className="h-3 w-3" /> Open
        </button>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
};

// Fill gaps: pick something that's missing, then type it in row by row. Also
// starts details research or lineup lookups for many events at once. Nothing
// is filled without you; lookups only propose.
export const FillGaps: React.FC<FillGapsProps> = ({ events, all, lineups, editions, onChanged, onRefresh, onOpen, onClose }) => {
  const counts = useMemo(() => gapCounts(events, lineups, editions), [events, lineups, editions]);
  const [gap, setGap] = useState<Gap>(() => GAPS.find((g) => counts[g] > 0) ?? 'date');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = events.filter((e) => hasGap(e, gap, lineups[e.id], editions[e.id]));
  const suggestions = useMemo(() => {
    switch (gap) {
      case 'venue':
        return byCount(all.flatMap((e) => (e.venue ? [e.venue] : [])));
      case 'city':
        return byCount(all.flatMap((e) => (e.city ? [e.city] : [])));
      case 'format':
        return byCount(all.flatMap((e) => (e.format ? [e.format] : [])));
      case 'seen':
        return byCount(all.flatMap((e) => e.seen.map((s) => s.name)));
      case 'companions':
        return byCount(all.flatMap((e) => e.companions));
      default:
        return [];
    }
  }, [gap, all]);

  const save = async (id: string, patch: EventPatch) => {
    setError(null);
    try {
      onChanged(await eventsApi.update(id, patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Stage 1 research for each row missing a date or place, one at a time.
  const researchable = rows.filter((e) => e.year || e.startDate);
  const research = async () => {
    setBusy('research');
    setError(null);
    let done = 0;
    for (const e of researchable) {
      setNote(`Looking up details: ${done + 1} of ${researchable.length}…`);
      try {
        onChanged(await eventsApi.research(e.id));
      } catch {
        // One failure doesn't stop the rest; the event keeps what it had.
      }
      done += 1;
    }
    setNote(`Looked up ${done} event${done === 1 ? '' : 's'}. Confirmed dates and places are filled in; anything else waits for your pick on the event.`);
    setBusy(null);
  };

  // Weather for each row, one at a time; rows it can't place say why.
  const [weatherNotes, setWeatherNotes] = useState<Record<string, string>>({});
  const lookUpWeather = async () => {
    setBusy('weather');
    setError(null);
    let found = 0;
    for (const [i, e] of rows.entries()) {
      setNote(`Looking up weather: ${i + 1} of ${rows.length}…`);
      try {
        const r = await eventsApi.weather(e.id);
        if (r.event.weather) {
          found += 1;
          onChanged(r.event);
        } else if (r.note) setWeatherNotes((n) => ({ ...n, [e.id]: r.note! }));
      } catch (err) {
        setWeatherNotes((n) => ({ ...n, [e.id]: err instanceof Error ? err.message : String(err) }));
      }
    }
    setNote(`Found the weather for ${found} of ${rows.length}.`);
    setBusy(null);
  };

  const lineupRows = rows.filter((e) => canFindLineup(e, lineups[e.id])).slice(0, 50);
  const findLineups = async () => {
    setBusy('lineups');
    setError(null);
    try {
      const r = await eventsApi.findLineups(lineupRows.map((e) => e.id));
      setNote(
        `Queued ${r.started.length} lineup lookup${r.started.length === 1 ? '' : 's'}. They run one at a time in the background; found lineups show up under "Lineup to review".`,
      );
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="h-full w-full max-w-2xl space-y-4 overflow-y-auto border-l border-zinc-900 bg-zinc-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Fill gaps</h2>
            <p className="text-xs text-zinc-400">
              Across the {events.length} event{events.length === 1 ? '' : 's'} the Table shows. Pick what's missing, type it in, press Enter.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {GAPS.map((g) => (
            <button
              key={g}
              onClick={() => {
                setGap(g);
                setNote(null);
              }}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                gap === g ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {GAP_LABELS[g]} <span className="text-zinc-500">{counts[g]}</span>
            </button>
          ))}
        </div>

        {(gap === 'date' || gap === 'venue' || gap === 'city') && researchable.length > 0 && (
          <button
            onClick={research}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40"
          >
            {busy === 'research' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Look up details for these {researchable.length}
          </button>
        )}
        {(gap === 'seen' || gap === 'type') && lineupRows.length > 0 && (
          <button
            onClick={findLineups}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/50 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-950/40 disabled:opacity-40"
          >
            {busy === 'lineups' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Find lineups for {lineupRows.length === 50 ? 'the first 50' : `these ${lineupRows.length}`}
          </button>
        )}
        {gap === 'weather' && rows.length > 0 && (
          <button
            onClick={lookUpWeather}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40"
          >
            {busy === 'weather' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudSun className="h-3.5 w-3.5" />}
            Look up weather for these {rows.length}
          </button>
        )}
        {note && <p className="text-xs text-zinc-400">{note}</p>}
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}

        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">Nothing missing here.</p>
        ) : (
          <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900">
            {rows.map((e) => (
              <li key={e.id} className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <button onClick={() => onOpen(e.id)} className="truncate text-left text-sm font-medium text-zinc-100 hover:underline">
                    {e.name}
                  </button>
                  <span className="shrink-0 text-xs text-zinc-500">{[whenLabel(e) ?? 'Date unknown', e.venue].filter(Boolean).join(' · ')}</span>
                </div>
                {gap === 'review' ? (
                  <ReviewRow
                    event={e}
                    onOpen={() => onOpen(e.id)}
                    onDone={(updated) => {
                      onChanged(updated);
                      onRefresh();
                    }}
                  />
                ) : (
                  <GapEditor event={e} gap={gap} suggestions={suggestions} onSave={(patch) => save(e.id, patch)} />
                )}
                {gap === 'weather' && weatherNotes[e.id] && <p className="text-[11px] text-amber-300/80">{weatherNotes[e.id]}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
