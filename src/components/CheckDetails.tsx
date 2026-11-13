import { useState } from 'react';
import { Check, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import type { DetailCandidate, DetailsStatus } from '../server/events/types';
import type { LineupStatus } from '../services/lineupApi';
import { candidateRowParts, checkedLabel, checkRows, type CheckRow } from '../services/checkDetails';
import { buildPickerView, type PickerChip } from '../services/pickerGroups';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';
import { SOURCE_LABELS } from '../services/lineupApi';

export interface Suggestion {
  key: string;
  label: string;
  yours: string;
  value: string;
  from: string;
  onUse: () => void;
}

interface Props {
  busy: boolean;
  geminiBusy: boolean;
  checkedAt?: string;
  status: DetailsStatus;
  candidates: DetailCandidate[];
  notes: string[];
  lineupStatus: LineupStatus | null;
  suggestions: Suggestion[];
  onCheck: () => void;
  onGemini: () => void;
  onPick: (id: string) => void;
  onNone: () => void;
  // Inside a card whose header holds the Check details button: no frame, title or button of its own, and the
  // Gemini step only once a check has run.
  inline?: boolean;
}

const ROW_TEXT: Record<CheckRow['state'], string> = {
  checking: 'checking',
  found: 'found',
  none: 'no listing',
  off: 'not set up',
};

// A wrapping row of filter chips. Tapping the chosen chip again clears it.
function ChipRow({ label, chips, active, onPick }: { label: string; chips: PickerChip[]; active: string | null; onPick: (key: string | null) => void }) {
  if (chips.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-xs text-zinc-400">{label}</span>
      {chips.map((c) => (
        <button key={c.key || 'none'} type="button" aria-pressed={active === c.key} onClick={() => onPick(active === c.key ? null : c.key)} className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
          <Pill tone={active === c.key ? 'accent' : 'neutral'}>
            {c.label} ({c.count})
          </Pill>
        </button>
      ))}
    </div>
  );
}

// Check details: searches the sources for this date and place. Nothing you typed changes. Suggestions are offered, never applied,
// and Gemini is a separate, opt-in second step.
export function CheckDetails({ busy, geminiBusy, checkedAt, status, candidates, notes, lineupStatus, suggestions, onCheck, onGemini, onPick, onNone, inline = false }: Props) {
  const [used, setUsed] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [city, setCity] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const view = buildPickerView(candidates, { city, month, search }, (c) =>
    [...new Set(c.sources.map((s) => SOURCE_LABELS[s.sourceType] + (s.readBy === 'gemini' ? ' (read by Gemini)' : '')))].join(', '),
  );
  const renderCandidate = (c: DetailCandidate) => {
    const row = candidateRowParts(c);
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => onPick(c.id)}
        className="flex w-full items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-left hover:border-violet-500"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm text-zinc-100">{row.name}</span>
          <span className="block truncate text-xs text-zinc-300">{row.date} · {row.venue} · {row.place}</span>
          <span className="block truncate text-[11px] text-zinc-400">
            {[...new Set(c.sources.map((s) => SOURCE_LABELS[s.sourceType] + (s.readBy === 'gemini' ? ' (read by Gemini)' : '')))].join(', ')}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Pill tone={row.sourceCount > 1 ? 'good' : 'neutral'}>{row.sourceText}</Pill>
          <Check className="h-4 w-4 text-violet-300" aria-hidden="true" />
        </span>
      </button>
    );
  };
  const left = lineupStatus?.quota ? Math.max(0, lineupStatus.quota.limit - lineupStatus.quota.used) : null;
  const rows = checkRows({
    busy,
    checkedAt,
    status,
    candidates,
    enabled: (type) => lineupStatus?.sources.find((s) => s.id === type)?.enabled,
  });
  const shown = suggestions.filter((s) => !used.includes(s.key));
  const geminiNotes = notes.filter((n) => n.startsWith('gemini:'));
  const last = checkedLabel(checkedAt, Date.now());
  const gemini = Boolean(lineupStatus?.gemini) && (!inline || Boolean(checkedAt));
  const live = (
    <p role="status" aria-live="polite" className="sr-only">
      {busy ? 'Checking details' : rows.length ? 'Check finished' : ''}
    </p>
  );
  if (inline && !rows.length && !last && status !== 'choose' && !shown.length && !gemini) return live;

  return (
    <div className={inline ? 'space-y-3' : 'space-y-3 rounded-xl border border-zinc-800 p-3'}>
      {!inline && <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-zinc-100">Check details</p>
          <p className="text-xs text-zinc-400">Searches Ticketmaster, setlist.fm, Clashfinder (when set up) and the web for this date and place. Nothing you typed is changed.</p>
        </div>
        <Button onClick={onCheck} disabled={busy || geminiBusy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check details
        </Button>
      </div>}
      {last && !busy && <p className="text-xs text-zinc-400">{last}</p>}
      {live}

      {rows.length > 0 && (
        <ul className="space-y-1 text-xs">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-2 text-zinc-300">
              <span>{r.label}</span>
              <span className={r.state === 'found' ? 'text-emerald-300' : 'text-zinc-400'}>{ROW_TEXT[r.state]}</span>
            </li>
          ))}
        </ul>
      )}

      {status === 'choose' && (
        <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-950/20 p-2.5">
          <p className="text-sm text-violet-200">{candidates.length && status === 'choose' ? 'Sources give different dates. Is it one of these?' : 'Is it one of these?'}</p>
          {view.grouped && (
            <div className="space-y-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search these choices"
                aria-label="Search these choices"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500"
              />
              <ChipRow label="City" chips={view.cityChips} active={city} onPick={setCity} />
              <ChipRow label="Month" chips={view.monthChips} active={month} onPick={setMonth} />
              <p role="status" aria-live="polite" className="text-xs text-zinc-400">
                Showing {view.shown} of {view.total}
                {view.shown === 0 && (
                  <>
                    . Nothing matches.{' '}
                    <button type="button" className="underline" onClick={() => { setSearch(''); setCity(null); setMonth(null); }}>Clear filters</button>
                  </>
                )}
              </p>
            </div>
          )}
          {view.groups.map((g) => (
            <div key={g.key} className="space-y-2">
              {view.grouped && <p className="pt-1 text-xs font-semibold text-zinc-300">{g.label} ({g.items.length})</p>}
              {g.items.map(renderCandidate)}
            </div>
          ))}
          <button type="button" onClick={onNone} className="text-xs text-zinc-400 hover:underline">
            None of these
          </button>
        </div>
      )}

      {shown.map((s) => (
        <div key={s.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-500/30 bg-violet-950/20 p-2.5 text-sm">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs text-zinc-400">{s.label}</p>
            <p className="text-zinc-300">
              Yours: <span className="text-zinc-100">{s.yours}</span>
            </p>
            <p className="text-zinc-300">
              Found: <span className="text-violet-200">{s.value}</span> <span className="text-xs text-zinc-400">from {s.from}</span>
            </p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setUsed((u) => [...u, s.key]);
              s.onUse();
            }}
          >
            Use
          </Button>
        </div>
      ))}

      {gemini && lineupStatus && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-300">
            Still missing something? Read the found pages with Gemini.
            {left !== null && lineupStatus.quota ? ` Uses up to 3 of the ${left} left today (of ${lineupStatus.quota.limit}).` : ''}
          </p>
          <Button onClick={onGemini} disabled={busy || geminiBusy || left === 0}>
            {geminiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Read with Gemini
          </Button>
          {left === 0 && <p className="text-xs text-amber-300/90">No Gemini reads left today{lineupStatus.quota?.exhaustedUntil ? `; the limit resets ${new Date(lineupStatus.quota.exhaustedUntil).toLocaleString()}` : ''}.</p>}
          {geminiNotes.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-zinc-400">
              {geminiNotes.map((n, i) => (
                <li key={i} className="break-all">
                  {n.replace(/^gemini: /, 'Gemini: ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status === 'off' && <p className="text-xs text-zinc-400"><ExternalLink className="hidden" aria-hidden="true" />No event source is set up, so details are as you typed them.</p>}
    </div>
  );
}
