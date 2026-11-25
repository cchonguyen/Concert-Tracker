import { Dialog } from './ui/Dialog';
import React, { useEffect, useMemo, useState } from 'react';
import { Check, Layers, Loader2, X } from 'lucide-react';
import { EventPatch, eventsApi, LoggedEvent } from '../services/lineupApi';
import { whenLabel } from '../services/format';
import { eventTitle, seriesList, SeriesSuggestion, seriesSuggestions, weekendFromName } from '../services/series';
import { EventTitle } from './EventTitle';

interface SeriesPanelProps {
  events: LoggedEvent[]; // your whole log
  onChanged: (event: LoggedEvent) => void;
  onOpen: (id: string) => void;
  onShow: (series: string) => void; // filter the Table to it
  onClose: () => void;
  // In the Manage tab: shown in place, not as a panel.
  embedded?: boolean;
  // Renames the series record everywhere (Manage); without it, each event
  // is saved with the new name.
  onRename?: (from: string, to: string) => Promise<void>;
}

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-400';

type Change = { event: LoggedEvent; patch: EventPatch };

// For a festival that runs more than one weekend. Empty: not set.
const WeekendSelect: React.FC<{ value?: number; disabled?: boolean; onChange: (w: number | null) => void; label: string }> = ({
  value,
  disabled,
  onChange,
  label,
}) => (
  <select
    value={value ?? ''}
    disabled={disabled}
    onChange={(ev) => onChange(ev.target.value ? Number(ev.target.value) : null)}
    aria-label={label}
    className="shrink-0 rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-300"
  >
    <option value="">Weekend</option>
    {[1, 2, 3, 4].map((w) => (
      <option key={w} value={w}>
        Weekend {w}
      </option>
    ))}
  </select>
);

const line = (e: LoggedEvent) => [whenLabel(e) ?? 'Date unknown', e.city].filter(Boolean).join(' · ');

// Offered from names that match once the year is taken out. Nothing is linked
// until you press Link; untick an event to leave it out, or change the name.
const Suggestion: React.FC<{
  s: SeriesSuggestion;
  busy: boolean;
  onLink: (name: string, changes: Change[]) => void;
}> = ({ s, busy, onLink }) => {
  const [name, setName] = useState(s.name);
  const [off, setOff] = useState<Set<string>>(new Set());
  // The weekend you set, else the one your name for the event gives.
  const [weekends, setWeekends] = useState<Record<string, number | undefined>>(() =>
    Object.fromEntries(s.events.map((e) => [e.id, e.weekend ?? weekendFromName(e.name)])),
  );
  const picked = s.events.filter((e) => !off.has(e.id));
  const toLink = picked.filter((e) => e.series !== name.trim() || (e.weekend ?? undefined) !== weekends[e.id]);
  return (
    <li className="space-y-2 rounded-xl border border-zinc-800 p-3">
      <input className={control} value={name} onChange={(e) => setName(e.target.value)} aria-label="Series name" />
      <ul className="space-y-1">
        {s.events.map((e) => {
          const on = !off.has(e.id);
          return (
            <li key={e.id}>
              <label className="flex cursor-pointer items-baseline gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setOff((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(e.id);
                      else next.delete(e.id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="text-zinc-200">{e.name}</span>
                  <span className="text-xs text-zinc-400"> · {line(e)}</span>
                  {on && name.trim() && (
                    <span className="block text-[11px] text-violet-300/80">
                      {e.series === name.trim() && e.weekend === weekends[e.id]
                        ? 'In this series'
                        : `Shows as “${eventTitle({ ...e, series: name.trim(), weekend: weekends[e.id] })}”`}
                    </span>
                  )}
                </span>
                {on && (
                  <WeekendSelect
                    value={weekends[e.id]}
                    label={`Weekend of ${e.name}`}
                    onChange={(w) => setWeekends((prev) => ({ ...prev, [e.id]: w ?? undefined }))}
                  />
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <button
        onClick={() =>
          onLink(
            name.trim(),
            toLink.map((e) => ({ event: e, patch: { series: name.trim(), weekend: weekends[e.id] ?? null } })),
          )
        }
        disabled={busy || !name.trim() || picked.length < 1 || !toLink.length}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent-fill px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Layers className="h-3 w-3" />} Link {toLink.length} as “{name.trim() || '…'}”
      </button>
    </li>
  );
};

// One of your series: rename it, add an edition, or take one out.
const Series: React.FC<{
  name: string;
  editions: LoggedEvent[];
  others: LoggedEvent[];
  busy: boolean;
  onSet: (series: string | null, events: LoggedEvent[]) => void;
  onRename?: (to: string) => void;
  onWeekend: (event: LoggedEvent, weekend: number | null) => void;
  onOpen: (id: string) => void;
  onShow: () => void;
}> = ({ name, editions, others, busy, onSet, onRename, onWeekend, onOpen, onShow }) => {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const renamed = draft.trim() && draft.trim() !== name;
  return (
    <li className="space-y-2 rounded-xl border border-zinc-800 p-3">
      <div className="flex items-center gap-2">
        <input className={control} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Rename ${name}`} />
        {renamed && (
          <button
            onClick={() => (onRename ? onRename(draft.trim()) : onSet(draft.trim(), editions))}
            disabled={busy}
            className="shrink-0 rounded-lg border border-violet-500/50 px-2.5 py-1.5 text-xs text-violet-200 hover:bg-violet-950/40 disabled:opacity-40"
          >
            Rename all {editions.length}
          </button>
        )}
        <button onClick={onShow} className="shrink-0 text-xs text-zinc-400 hover:text-violet-300">
          Show in Table
        </button>
      </div>
      <ul className="divide-y divide-zinc-900">
        {editions.map((e) => (
          <li key={e.id} className="flex items-baseline justify-between gap-2 py-1.5 text-sm">
            <button onClick={() => onOpen(e.id)} className="min-w-0 flex-1 text-left hover:text-violet-300">
              <span className="font-medium text-zinc-100"><EventTitle event={e} /></span>
              <span className="text-xs text-zinc-400"> · {line(e)}</span>
              {e.name !== eventTitle(e) && <span className="block truncate text-[11px] text-zinc-400">typed as “{e.name}”</span>}
            </button>
            <WeekendSelect value={e.weekend} disabled={busy} label={`Weekend of ${e.name}`} onChange={(w) => onWeekend(e, w)} />
            <button
              onClick={() => onSet(null, [e])}
              disabled={busy}
              className="shrink-0 text-xs text-zinc-400 hover:text-rose-300 disabled:opacity-40"
              aria-label={`Take ${e.name} out of ${name}`}
            >
              Take out
            </button>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <select
          className={control}
          value=""
          disabled={busy}
          onChange={(ev) => {
            const e = others.find((o) => o.id === ev.target.value);
            if (e) onSet(name, [e]);
          }}
          aria-label={`Add an event to ${name}`}
        >
          <option value="">Add another event to this series…</option>
          {others.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({whenLabel(e) ?? 'date unknown'})
            </option>
          ))}
        </select>
      )}
    </li>
  );
};

// Series in the Table: link the years of a festival or tour so they show as
// "EDC Las Vegas 2023", "EDC Las Vegas 2024", ... The name you typed stays on
// each event. Saves one event at a time through the event route.
export const SeriesPanel: React.FC<SeriesPanelProps> = ({ events, onChanged, onOpen, onShow, onClose, embedded, onRename }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const suggestions = useMemo(() => seriesSuggestions(events), [events]);
  const yours = useMemo(() => seriesList(events), [events]);
  const unlinked = useMemo(
    () => events.filter((e) => !e.series).sort((a, b) => a.name.localeCompare(b.name)),
    [events],
  );

  // Saves one event at a time through the event route.
  const apply = async (changes: Change[], message: (saved: number) => string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    let saved = 0;
    try {
      for (const c of changes) {
        onChanged(await eventsApi.update(c.event.id, c.patch));
        saved += 1;
      }
      setDone(message(saved));
    } catch (err) {
      setError(`${saved} of ${changes.length} saved. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const events_ = (n: number) => `${n} event${n === 1 ? '' : 's'}`;
  const setSeries = (series: string | null, list: LoggedEvent[]) =>
    apply(
      list.map((event) => ({ event, patch: series ? { series } : { series: null, weekend: null } })),
      (n) => (series ? `${events_(n)} now in “${series}”.` : `${events_(n)} taken out of the series.`),
    );

  const rename = async (from: string, to: string) => {
    if (!onRename) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await onRename(from, to);
      setDone(`Renamed to “${to}” on every event.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      {!embedded && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-zinc-50">Series</h2>
            <p className="text-xs text-zinc-400">
              Link the years of a festival or tour so they read the same everywhere: EDC Las Vegas 2023, 2024, 2025. The name you typed stays on
              each event.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}
      {done && (
        <p className="inline-flex items-center gap-1 text-sm text-emerald-300">
          <Check className="h-4 w-4" /> {done}
        </p>
      )}

      <section className="space-y-2">
        <h3 className={sectionTitle}>Same name, different years</h3>
        {suggestions.length ? (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <Suggestion
                key={`${s.key}-${s.events.length}-${s.linked}`}
                s={s}
                busy={busy}
                onLink={(name, changes) => void apply(changes, (n) => `${events_(n)} now in “${name}”.`)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-400">No events left whose names match once the year is taken out.</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className={sectionTitle}>Your series</h3>
        {yours.length ? (
          <ul className="space-y-2">
            {yours.map((g) => (
              <Series
                key={g.name}
                name={g.name}
                editions={g.events}
                others={unlinked}
                busy={busy}
                onSet={(series, list) => void setSeries(series, list)}
                onRename={onRename ? (to) => void rename(g.name, to) : undefined}
                onWeekend={(event, weekend) =>
                  void apply([{ event, patch: { weekend } }], () => (weekend ? `${eventTitle({ ...event, weekend })} saved.` : 'Weekend cleared.'))
                }
                onOpen={onOpen}
                onShow={() => onShow(g.name)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-400">None yet. Link a suggestion above, or type a series on an event.</p>
        )}
      </section>
    </>
  );
  if (embedded) return <div className="space-y-5">{body}</div>;
  return (
    <Dialog title="Series" onClose={onClose} panelClassName="h-full w-full max-w-2xl space-y-5 overflow-y-auto border-l border-zinc-900 bg-zinc-950 p-5 shadow-2xl">
      {body}
    </Dialog>
  );
};
