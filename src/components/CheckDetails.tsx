import { useEffect, useState } from 'react';
import { Check, ExternalLink, RefreshCw, Search } from 'lucide-react';
import { Equalizer } from './ui/Equalizer';
import type { DetailCandidate, DetailsStatus } from '../server/events/types';
import type { LineupStatus } from '../services/lineupApi';
import { candidateRowParts, checkedLabel, checkRows, type CheckRow } from '../services/checkDetails';
import { weekendLabel } from '../services/format';
import { buildPickerView, type PickerChip } from '../services/pickerGroups';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';
import { SOURCE_LABELS } from '../services/lineupApi';
import { SourceIcon } from './ui/SourceIcon';

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
  onDismissCanon?: () => void;
  dismissBusy?: boolean;
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
      <span className="text-xs text-text-muted">{label}</span>
      {chips.map((c) => (
        <button key={c.key || 'none'} type="button" aria-pressed={active === c.key} onClick={() => onPick(active === c.key ? null : c.key)} className="inline-flex min-h-11 items-center sm:min-h-9 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
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
export function CheckDetails({ busy, geminiBusy, checkedAt, status, candidates, notes, lineupStatus, suggestions, onCheck, onGemini, onPick, onNone, onDismissCanon, dismissBusy = false, inline = false }: Props) {
  const [used, setUsed] = useState<string[]>([]);
  useEffect(() => {
    setUsed([]);
  }, [checkedAt]);
  const [search, setSearch] = useState('');
  const [city, setCity] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const view = buildPickerView(candidates, { city, month, search }, (c) =>
    [...new Set(c.sources.map((s) => SOURCE_LABELS[s.sourceType] + (s.readBy === 'gemini' ? ' (read by AI)' : '')))].join(', '),
  );
  const renderCandidate = (c: DetailCandidate) => {
    const row = candidateRowParts(c);
    if (c.editionId) {
      return (
        <div
          key={c.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line bg-page p-2.5 text-left"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-text">{row.name}</span>
              {c.seriesName && <Pill tone="neutral">{c.seriesName}</Pill>}
            </div>
            <p className="truncate text-xs text-text-muted">
              {row.date} · {row.venue} · {row.place}
            </p>
            {c.weekends && c.weekends.length > 1 && (
              <p className="text-[11px] text-text-muted">{c.weekends.length} weekends</p>
            )}
          </div>
          <Button variant="primary" onClick={() => onPick(c.id)} disabled={dismissBusy}>
            Link
          </Button>
        </div>
      );
    }
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => onPick(c.id)}
        className="min-h-11 sm:min-h-9 flex w-full items-start justify-between gap-3 rounded-control border border-line bg-page p-2.5 text-left hover:border-accent"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm text-text">{row.name}</span>
          <span className="block truncate text-xs text-text-muted">{row.date} · {row.venue} · {row.place}</span>
          {c.weekends && c.weekends.length > 1 && (
            <span className="block truncate text-[11px] text-accent">
              {c.weekends.length} weekends ({c.weekends.map((w) => weekendLabel(w, 'WK')).join(' · ')})
            </span>
          )}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted">
            {[...new Map(c.sources.map((s) => [`${s.sourceType}|${s.readBy ?? ''}`, s])).values()].map((s) => (
              <SourceIcon key={`${s.sourceType}|${s.readBy ?? ''}`} source={s.sourceType} readBy={s.readBy} />
            ))}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Pill tone={row.sourceCount > 1 ? 'good' : 'neutral'}>{row.sourceText}</Pill>
          <Check className="h-4 w-4 text-accent" aria-hidden="true" />
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
  const hasCanonCandidates = candidates.some((c) => Boolean(c.editionId));
  const showChoice = status === 'choose' || (status === 'candidates' && candidates.length > 0);
  if (inline && !rows.length && !last && !showChoice && !shown.length && !gemini) return live;

  return (
    <div className={inline ? 'space-y-3' : 'space-y-3 rounded-card border border-line p-3'}>
      {!inline && <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-text">Check details</p>
          <p className="text-xs text-text-muted">Searches Ticketmaster, setlist.fm, Clashfinder (when set up) and the web for this date and place. Nothing you typed is changed.</p>
        </div>
        <Button onClick={onCheck} disabled={busy || geminiBusy}>
          {busy ? <Equalizer size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />} Check details
        </Button>
      </div>}
      {last && !busy && <p className="text-xs text-text-muted">{last}</p>}
      {live}

      {rows.length > 0 && (
        <ul className="space-y-1 text-xs">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-2 text-text-muted">
              <span>{r.label}</span>
              <span className={r.state === 'found' ? 'text-good' : 'text-text-muted'}>{ROW_TEXT[r.state]}</span>
            </li>
          ))}
        </ul>
      )}

      {showChoice && (
        <div className="space-y-2 rounded-control border border-accent-tint-line bg-accent-tint p-2.5">
          <p className="text-sm text-accent">
            {status === 'candidates' || hasCanonCandidates
              ? 'Is it one of these?'
              : candidates.length && status === 'choose'
                ? 'Sources give different dates. Is it one of these?'
                : 'Is it one of these?'}
          </p>
          {view.grouped && (
            <div className="space-y-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search these choices"
                aria-label="Search these choices"
                className="w-full rounded-control border border-line-strong bg-page px-2.5 py-1.5 text-sm text-text placeholder:text-text-muted"
              />
              <ChipRow label="City" chips={view.cityChips} active={city} onPick={setCity} />
              <ChipRow label="Month" chips={view.monthChips} active={month} onPick={setMonth} />
              <p role="status" aria-live="polite" className="text-xs text-text-muted">
                Showing {view.shown} of {view.total}
                {view.shown === 0 && (
                  <>
                    . Nothing matches.{' '}
                    <button type="button" className="inline-flex min-h-11 items-center sm:min-h-9 underline" onClick={() => { setSearch(''); setCity(null); setMonth(null); }}>Clear filters</button>
                  </>
                )}
              </p>
            </div>
          )}
          {view.groups.map((g) => (
            <div key={g.key} className="space-y-2">
              {view.grouped && <p className="pt-1 text-xs font-semibold text-text-muted">{g.label} ({g.items.length})</p>}
              {g.items.map(renderCandidate)}
            </div>
          ))}
          {status === 'candidates' && onDismissCanon ? (
            <button type="button" onClick={onDismissCanon} disabled={dismissBusy} className="inline-flex min-h-11 items-center sm:min-h-9 text-xs text-text-muted hover:underline disabled:opacity-50">
              {dismissBusy ? 'Dismissing…' : 'None of these — search web / keep mine'}
            </button>
          ) : (
            <button type="button" onClick={onNone} className="inline-flex min-h-11 items-center sm:min-h-9 text-xs text-text-muted hover:underline">
              None of these
            </button>
          )}
        </div>
      )}

      {shown.map((s) => (
        <div key={s.key} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-accent-tint-line bg-accent-tint p-2.5 text-sm">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs text-text-muted">{s.label}</p>
            <p className="text-text-muted">
              Yours: <span className="text-text">{s.yours}</span>
            </p>
            <p className="text-text-muted">
              Found: <span className="text-accent">{s.value}</span> <span className="text-xs text-text-muted">from {s.from}</span>
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
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-xs text-text-muted">
            Still missing something? Deep search has AI read the pages found above for details the quick check missed.
            {left !== null && lineupStatus.quota ? ` Uses up to 3 of the ${left} AI reads left today (of ${lineupStatus.quota.limit}).` : ''}
          </p>
          <Button onClick={onGemini} disabled={busy || geminiBusy || left === 0}>
            {geminiBusy ? <Equalizer size="sm" /> : <Search className="h-3.5 w-3.5" />} Deep search with AI
          </Button>
          {left === 0 && <p className="text-xs text-warn">No AI reads left today{lineupStatus.quota?.exhaustedUntil ? `; the limit resets ${new Date(lineupStatus.quota.exhaustedUntil).toLocaleString()}` : ''}.</p>}
          {geminiNotes.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-text-muted">
              {geminiNotes.map((n, i) => (
                <li key={i} className="break-all">
                  {n.replace(/^gemini: /, 'Deep search: ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status === 'off' && <p className="text-xs text-text-muted"><ExternalLink className="hidden" aria-hidden="true" />No event source is set up, so details are as you typed them.</p>}
    </div>
  );
}
