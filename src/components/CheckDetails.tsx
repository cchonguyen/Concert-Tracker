import { useState } from 'react';
import { Check, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import type { DetailCandidate, DetailsStatus } from '../server/events/types';
import type { LineupStatus } from '../services/lineupApi';
import { checkedLabel, checkRows, type CheckRow } from '../services/checkDetails';
import { Button } from './ui/Button';
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
}

const ROW_TEXT: Record<CheckRow['state'], string> = {
  checking: 'checking',
  found: 'found',
  none: 'no listing',
  off: 'not set up',
};

// Check details: searches the sources for this date and place. Nothing you typed changes. Suggestions are offered, never applied,
// and Gemini is a separate, opt-in second step.
export function CheckDetails({ busy, geminiBusy, checkedAt, status, candidates, notes, lineupStatus, suggestions, onCheck, onGemini, onPick, onNone }: Props) {
  const [used, setUsed] = useState<string[]>([]);
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

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-zinc-100">Check details</p>
          <p className="text-xs text-zinc-400">Searches Ticketmaster, setlist.fm, Clashfinder (when set up) and the web for this date and place. Nothing you typed is changed.</p>
        </div>
        <Button onClick={onCheck} disabled={busy || geminiBusy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check details
        </Button>
      </div>
      {last && !busy && <p className="text-xs text-zinc-400">{last}</p>}
      <p role="status" aria-live="polite" className="sr-only">
        {busy ? 'Checking details' : rows.length ? 'Check finished' : ''}
      </p>

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
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c.id)}
              className="flex w-full items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-left hover:border-violet-500"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-zinc-100">{c.name}</span>
                <span className="block truncate text-[11px] text-zinc-400">
                  {[...new Set(c.sources.map((s) => SOURCE_LABELS[s.sourceType] + (s.readBy === 'gemini' ? ' (read by Gemini)' : '')))].join(', ')}
                </span>
              </span>
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" aria-hidden="true" />
            </button>
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

      {lineupStatus?.gemini && (
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
