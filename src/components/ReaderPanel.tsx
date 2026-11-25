import type { LineupStatus, ReaderStatus } from '../services/lineupApi';
import { Pill } from './ui/Pill';

const money = (n: number | undefined | null): string => (typeof n === 'number' ? `$${n.toFixed(n < 1 ? 4 : 2)}` : 'not recorded');
const count = (n: number | null | undefined): string => (typeof n === 'number' ? n.toLocaleString() : 'not recorded');
const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'not recorded' : d.toLocaleString();
};

// One owner line for the About dialog and the top of the panel.
export function readerLine(r: ReaderStatus): string {
  const parts = [
    `${r.provider} ${r.model}`,
    `thinking ${r.thinkingLevel}`,
    `${r.callsToday} calls today, ${r.callsMonth} this month`,
    `spend today ${money(r.spendTodayUsd)}, month ${money(r.spendMonthUsd)}`,
  ];
  if (!r.enabled) parts.push('off');
  if (r.breaker.open) parts.push(`paused until ${r.breaker.until ? when(r.breaker.until) : 'not recorded'}`);
  return parts.join(' · ');
}

const tone = (outcome: string): 'good' | 'warn' | 'neutral' => (outcome === 'ok' ? 'good' : outcome === 'blocked' || outcome.includes('fail') || outcome === 'invalid_json' ? 'warn' : 'neutral');

// Observability only: what the reader did lately. No controls. Owner only (the server sends `recent` to the owner alone).
export function ReaderPanel({ status }: { status: LineupStatus | null }) {
  if (!status) return null;
  const r = status.reader;
  if (!r) {
    return (
      <section className="mt-6 space-y-2 text-sm text-text-muted">
        <h3 className="font-display text-lg font-normal text-text">Reader</h3>
        <p>Reader not configured</p>
      </section>
    );
  }
  const recent = (r.recent ?? []).slice(0, 20);
  return (
    <section className="mt-6 space-y-3 text-sm text-text-muted" aria-label="Reader">
      <h3 className="font-display text-lg font-normal text-text">Reader</h3>
      <p className="break-words">{readerLine(r)}</p>
      {r.caps && (
        <p className="break-words text-xs text-text-muted">
          Caps: {money(r.caps.dayUsd)} a day, {money(r.caps.monthUsd)} a month, {r.caps.perJob} calls a job. Log write failures today:{' '}
          {count(r.logWriteFailuresToday)}.
        </p>
      )}
      {recent.length === 0 ? (
        <p className="text-text-muted">No calls recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {recent.map((c, i) => (
            <li key={`${c.createdAt}-${i}`} className="space-y-1 rounded-control border border-line p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-text-muted">{when(c.createdAt)}</span>
                <span className="break-words font-medium text-text">{c.feature}</span>
                <Pill tone={tone(c.outcome)}>{c.outcome}</Pill>
              </div>
              <p className="break-words text-text-muted">
                {c.provider} {c.model} · in {count(c.inputTokens)} · out {count(c.outputTokens)} · cost {money(c.estCostUsd)}
              </p>
              {c.reason && <p className="break-words text-text-muted">Guard: {c.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
