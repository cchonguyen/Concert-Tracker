import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, MapPin, Plus } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { parseEventInput } from '../server/events/parse';
import { eventsApi, EditionSuggestion, LoggedEvent, suggestEditions } from '../services/lineupApi';
import { suggestionPlaceLabel, suggestionWhenLabel, whenLabel } from '../services/format';
import { isAhead } from '../server/events/attendance';
import { isSampleMode } from '../services/sampleMode';
import { Equalizer } from './ui/Equalizer';
import { HintPill } from './ui/HintPill';

interface CaptureBarProps {
  onCaptured: (event: LoggedEvent) => void;
  compact?: boolean; // in the Table: no focus grab, shorter label
  label?: string; // replaces the heading (Home's empty state)
}

const MAX_ROWS = 5;

// A picked edition fills the line as "<name> <year>", the year only when the name lacks it.
const editionText = (s: EditionSuggestion): string => (s.year && !s.name.includes(String(s.year)) ? `${s.name} ${s.year}` : s.name);

// The edition's facts, each left out when unknown: date (or weekends/year), venue and full place, acts.
function editionFacts(s: EditionSuggestion, matchedWeekend?: number): string[] {
  const when = suggestionWhenLabel(s, matchedWeekend);
  const place = [s.venue, suggestionPlaceLabel(s)].filter(Boolean).join(', ') || null;
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
  const still = useReducedMotion();
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
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      suggestEditions(name, controller.signal).then(
        (rows) => {
          if (controller.signal.aborted) return;
          setEditions(rows);
        },
        (err) => {
          if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
          // Suggestions are optional: an error shows none.
          setEditions([]);
        },
      );
    }, 300);
    return () => {
      controller.abort();
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
      onCaptured(await eventsApi.create(editionText(s), s.id, undefined, parsed?.weekend));
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
      <label className="block text-sm font-semibold text-text-muted" htmlFor="capture">
        {label ?? (compact ? 'Add an event, past or upcoming' : 'What did you go to?')}
      </label>
      <div className="relative">
        <div className="flex items-center gap-2 rounded-card border border-line-strong bg-surface-1 p-1.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
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
            className="min-h-11 min-w-0 flex-1 bg-transparent px-3 py-1.5 text-base text-text placeholder:text-text-faint focus:outline-none sm:min-h-10"
          />
          <button
            type="submit"
            disabled={!text.trim() || saving}
            aria-label="Add event"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control bg-accent-fill px-4 text-sm font-semibold text-on-accent hover:brightness-110 disabled:opacity-40 sm:min-h-10"
          >
            {saving ? <Equalizer size="sm" /> : <Plus aria-hidden="true" className="h-4 w-4" />}
            <span className="hidden sm:inline">Add</span>
          </button>
        </div>
        <AnimatePresence>
          {rows.length > 0 && (
            <motion.ul
              id="capture-editions"
              role="listbox"
              aria-label="Matching editions"
              initial={still ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={still ? undefined : { opacity: 0, y: -4 }}
              transition={{ duration: still ? 0 : 0.15, ease: 'easeOut' }}
              className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-60 overflow-y-auto rounded-card border border-line-strong bg-surface-1 py-1 shadow-xl"
            >
              {rows.map((s, i) => {
                const facts = editionFacts(s, parsed?.weekend);
                return (
                  <li key={s.id} id={rowId(i)} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      // Keep focus in the input, so its blur doesn't close the list before the tap lands.
                      onPointerDown={(e) => e.preventDefault()}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickEdition(s)}
                      className={`block w-full px-3.5 py-2 text-left text-sm ${
                        i === active ? 'bg-accent-tint text-accent' : 'text-text hover:bg-surface-2'
                      }`}
                    >
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-semibold">{s.name}</span>
                        {(s.seriesName || s.seriesBrand) && (
                          <span className="rounded-control border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-muted">
                            {[s.seriesName, s.seriesBrand].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                      {facts.length > 0 && <span className="block truncate text-xs text-text-muted">{facts.join(' · ')}</span>}
                    </button>
                  </li>
                );
              })}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {parsed && (
          <motion.div
            initial={still ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={still ? undefined : { opacity: 0 }}
            transition={{ duration: still ? 0 : 0.14 }}
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <span className="rounded-control border border-line bg-surface-2 px-2.5 py-1 font-semibold text-text">{parsed.name || '…'}</span>
            {parsed.weekend && <HintPill tone="info">Weekend {parsed.weekend}</HintPill>}
            <span
              className={`inline-flex items-center gap-1 rounded-control px-2.5 py-1 ${
                when ? 'border border-line bg-surface-2 font-mono tabular-nums text-text' : 'text-text-muted'
              }`}
            >
              <CalendarDays className="h-3 w-3" aria-hidden="true" /> {when ?? 'no date yet (that’s fine)'}
            </span>
            {ahead && (
              <span title="Counted once you say you went">
                <HintPill tone="info">Upcoming: you'll be asked if you went</HintPill>
              </span>
            )}
            {(parsed.venue || parsed.city) && (
              <span className="inline-flex items-center gap-1 rounded-control border border-line bg-surface-2 px-2.5 py-1 text-text">
                <MapPin className="h-3 w-3" aria-hidden="true" /> {[parsed.venue, parsed.city].filter(Boolean).join(', ')}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p className="text-sm text-bad">{error}</p>}
    </form>
  );
};
