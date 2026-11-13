import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Loader2, MapPin, Plus } from 'lucide-react';
import { parseEventInput } from '../server/events/parse';
import { eventsApi, EditionSuggestion, LoggedEvent, suggestEditions } from '../services/lineupApi';
import { whenLabel } from '../services/format';
import { isAhead } from '../server/events/attendance';
import { isSampleMode } from '../services/sampleMode';

interface CaptureBarProps {
  onCaptured: (event: LoggedEvent) => void;
  compact?: boolean; // in the Table: no focus grab, shorter label
  label?: string; // replaces the heading (Home's empty state)
}

const MAX_ROWS = 5;

// A picked edition fills the line as "<name> <year>", the year only when the name lacks it.
const editionText = (s: EditionSuggestion): string => (s.year && !s.name.includes(String(s.year)) ? `${s.name} ${s.year}` : s.name);

// The edition's facts, each left out when unknown: date (or year), venue and city, acts.
function editionFacts(s: EditionSuggestion): string[] {
  const when = s.startDate ? whenLabel({ startDate: s.startDate, endDate: s.endDate, year: s.year }) : s.year ? String(s.year) : null;
  const place = [s.venue, s.city].filter(Boolean).join(', ') || null;
  const acts = s.actCount > 0 ? `${s.actCount} ${s.actCount === 1 ? 'act' : 'acts'}` : null;
  return [when, place, acts].filter((x): x is string => Boolean(x));
}

// Stage 1: one line in, saved at once. The preview shows how the line will be
// split, so nothing surprising is stored.
export const CaptureBar: React.FC<CaptureBarProps> = ({ onCaptured, compact, label }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editions, setEditions] = useState<EditionSuggestion[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => (text.trim() ? parseEventInput(text) : null), [text]);
  const when = parsed && whenLabel(parsed);
  const ahead = parsed ? isAhead(parsed, new Date().toISOString().slice(0, 10)) : false;

  // Edition suggestions: debounced, two or more letters, latest request only, never in sample mode.
  const name = parsed?.name?.trim() ?? '';
  const queryable = (name.match(/\p{L}/gu) ?? []).length >= 2 && !isSampleMode();
  useEffect(() => {
    setActive(-1);
    // The last rows stay on screen while the next request is pending.
    if (!queryable) {
      setEditions([]);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      suggestEditions(name).then(
        (rows) => {
          if (stale) return;
          setEditions(rows);
        },
        () => {
          // Suggestions are optional: an error shows none.
          if (!stale) setEditions([]);
        },
      );
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [name, queryable]);

  const rows = listOpen && !saving ? editions.slice(0, MAX_ROWS) : [];
  const rowId = (i: number) => `capture-edition-${i}`;

  // A picked edition saves at once, copied from the edition (stage 1, no research).
  const pickEdition = async (s: EditionSuggestion) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setListOpen(false);
    setActive(-1);
    try {
      onCaptured(await eventsApi.create(editionText(s), s.id));
      setText('');
      setEditions([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!rows.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? rows.length - 1 : i - 1));
    } else if (e.key === 'Enter' && rows[active]) {
      // With a row highlighted, Enter picks it; without one, the form submits as usual.
      e.preventDefault();
      pickEdition(rows[active]);
    } else if (e.key === 'Escape') {
      setListOpen(false);
      setActive(-1);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      onCaptured(await eventsApi.create(text, undefined, true));
      setText('');
      setEditions([]);
      setListOpen(false);
      setActive(-1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="block text-sm font-semibold text-zinc-300" htmlFor="capture">
        {label ?? (compact ? 'Add an event, past or upcoming' : 'What did you go to?')}
      </label>
      <div className="relative">
        <div className="flex gap-2">
          <input
            id="capture"
            ref={inputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls="capture-editions"
            aria-activedescendant={rows[active] ? rowId(active) : undefined}
            autoFocus={!compact}
            autoComplete="off"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setListOpen(true);
              setActive(-1);
            }}
            onFocus={() => setListOpen(true)}
            onBlur={() => {
              setListOpen(false);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
            placeholder="Porter Robinson at the Greek, Oct 5 2024"
            className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-base text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!text.trim() || saving}
            aria-label="Add event"
            className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
          >
            {saving ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Plus aria-hidden="true" className="h-4 w-4" />}
            <span className="hidden sm:inline">Add</span>
          </button>
        </div>
        {rows.length > 0 && (
          <ul
            id="capture-editions"
            role="listbox"
            aria-label="Matching editions"
            className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
          >
            {rows.map((s, i) => {
              const facts = editionFacts(s);
              return (
                <li key={s.id} id={rowId(i)} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    // Keep focus in the input, so its blur doesn't close the list before the tap lands.
                    onPointerDown={(e) => e.preventDefault()}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickEdition(s)}
                    className={`block w-full px-3 py-2 text-left text-sm ${
                      i === active ? 'bg-violet-600/30 text-violet-100' : 'text-zinc-200 hover:bg-zinc-800'
                    }`}
                  >
                    <span className="block truncate font-semibold">{s.name}</span>
                    {facts.length > 0 && <span className="block truncate text-xs text-zinc-400">{facts.join(' · ')}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {parsed && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-zinc-800 px-2.5 py-1 font-semibold text-zinc-100">{parsed.name || '…'}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${when ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400'}`}>
            <CalendarDays className="h-3 w-3" /> {when ?? 'no date yet (that’s fine)'}
          </span>
          {ahead && (
            <span className="rounded-full bg-sky-500/10 px-2.5 py-1 text-sky-300" title="Counted once you say you went">
              Upcoming: you'll be asked if you went
            </span>
          )}
          {(parsed.venue || parsed.city) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-200">
              <MapPin className="h-3 w-3" /> {[parsed.venue, parsed.city].filter(Boolean).join(', ')}
            </span>
          )}
        </div>
      )}
      {error && <p className="text-sm text-rose-300">{error}</p>}
    </form>
  );
};
