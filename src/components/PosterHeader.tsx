import { Check, ChevronRight } from 'lucide-react';
import type { LoggedEvent, SeenAct } from '../server/events/types';
import type { AttendanceState } from '../server/events/attendance';
import { billLines, GAP_LABEL, gapQuestion } from '../services/poster';
import type { Gap } from '../services/table';
import { Pill } from './ui/Pill';
import { Stars } from './ui/Stars';

const STATUS: Record<AttendanceState, { text: string; tone: 'good' | 'warn' | 'neutral' }> = {
  went: { text: 'Counted', tone: 'good' },
  upcoming: { text: 'Upcoming', tone: 'neutral' },
  confirm: { text: 'Did you go?', tone: 'warn' },
  missed: { text: "Didn't go", tone: 'neutral' },
};

interface Props {
  title: string;
  label: string; // Date, venue and city, as one line.
  event: LoggedEvent;
  state: AttendanceState;
  seen: SeenAct[];
  cited: string[]; // Keys of the lineup's acts that are not cancelled.
  confirmedBy: number; // How many sources confirm the date.
  onRate: (rating: number | null) => void;
}

// The top of the event detail, edge to edge like a gig poster: the date and place, the event's name, the bill
// (headliners on the bigger line, everyone else on the smaller one) and status pills. Sizes come from billing,
// never from list order.
export function PosterHeader({ title, label, event, state, seen, cited, confirmedBy, onRate }: Props) {
  const bill = billLines(seen, cited);
  const small = [...bill.medium.map((a) => a.name), ...(bill.more > 0 ? [`+ ${bill.more} more`] : [])];
  const status = STATUS[state];
  return (
    <header className="poster-bg space-y-2 border-b border-line-strong px-5 pb-5 pt-6">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 pt-1 font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-text-muted">{label}</p>
        {/* Your rating: tap a star to rate, tap the current one again to clear it. */}
        <Stars value={event.rating == null ? null : Math.max(1, Math.min(5, Math.round(event.rating)))} onChange={onRate} size="md" className="-mr-1.5 -mt-2 shrink-0" />
      </div>
      <h2 className="font-display text-[2.1rem] font-medium leading-[1.05] tracking-tight text-text sm:text-5xl">{title}</h2>
      {bill.large.length > 0 && <p className="text-lg font-semibold leading-snug text-text">{bill.large.map((a) => a.name).join(' · ')}</p>}
      {small.length > 0 && <p className="text-sm font-medium text-text-muted">{small.join(' · ')}</p>}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 pt-2">
        <div className="flex flex-wrap gap-2">
          <Pill tone={status.tone}>
            {status.tone === 'good' && <Check className="h-3 w-3" aria-hidden="true" />}
            {status.text}
          </Pill>
          {confirmedBy > 0 && (
            <Pill tone="good">
              Date confirmed · {confirmedBy} {confirmedBy === 1 ? 'source' : 'sources'}
            </Pill>
          )}
          {cited.length > 0 && <Pill tone="accent">Lineup · {cited.length} acts, all cited</Pill>}
        </div>
        {state === 'upcoming' && <p className="text-xs text-text-muted sm:text-right">Upcoming. Not counted until you say you went.</p>}
      </div>
    </header>
  );
}

interface StripProps {
  gaps: Gap[];
  current: Gap | null; // The gap being asked about; its question shows in the strip.
  needsWeekend?: boolean;
  onPick: (gap: Gap) => void;
  onNext: () => void;
}

// What the event still needs, on one line: the count, a chip per gap (the one being asked about is lit) and Next.
// Nothing left reads "All filled in".
export function ThingsLeft({ gaps, current, needsWeekend, onPick, onNext }: StripProps) {
  if (gaps.length === 0) {
    return (
      <p className="flex items-center gap-1.5 rounded-card border border-good/45 px-4 py-2.5 text-sm font-semibold text-good">
        <Check className="h-4 w-4" aria-hidden="true" /> All filled in
      </p>
    );
  }
  return (
    <section aria-label="Still to fill in" className="flex flex-wrap items-center gap-2 rounded-card border border-accent-tint-line bg-accent-tint px-3 py-2">
      <p className="text-sm font-semibold text-text">
        {gaps.length} {gaps.length === 1 ? 'thing' : 'things'} left
      </p>
      <span className="text-text-faint" aria-hidden="true">
        ·
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {gaps.map((g) => (
          <li key={g}>
            <button
              type="button"
              aria-pressed={g === current}
              onClick={() => onPick(g)}
              className={`min-h-11 rounded-control border px-3 text-sm sm:min-h-9 ${
                g === current ? 'border-accent bg-surface-1 font-semibold text-text' : 'border-line-strong text-text-muted hover:border-accent hover:text-text'
              }`}
            >
              {GAP_LABEL[g]}
            </button>
          </li>
        ))}
      </ul>
      {current && <span className="min-w-0 text-sm text-text">{gapQuestion(current, { needsWeekend })}</span>}
      <span className="grow" />
      <button
        type="button"
        onClick={onNext}
        className="inline-flex min-h-11 items-center gap-0.5 rounded-control bg-accent-fill px-3 text-sm font-semibold text-on-accent hover:brightness-110 sm:min-h-9"
      >
        Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
