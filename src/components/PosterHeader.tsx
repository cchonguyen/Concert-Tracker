import { ArrowRight, Check } from 'lucide-react';
import type { LoggedEvent, SeenAct } from '../server/events/types';
import type { AttendanceState } from '../server/events/attendance';
import { billLines, GAP_LABEL, GAP_QUESTION } from '../services/poster';
import type { Gap } from '../services/table';
import { Pill } from './ui/Pill';

const STATUS: Record<AttendanceState, string> = {
  went: 'Counted',
  upcoming: 'Upcoming',
  confirm: 'Did you go?',
  missed: "Didn't go",
};

interface Props {
  title: string;
  dateText: string;
  event: LoggedEvent;
  state: AttendanceState;
  seen: SeenAct[];
  cited: string[]; // Keys of the lineup's acts that are not cancelled.
}

// The poster's background: a violet glow top-left and a rose glow bottom-right over the panel, as in the design.
const POSTER_BACKGROUND =
  'radial-gradient(90% 140% at 12% 0%, rgba(139,92,246,.42), transparent 60%), radial-gradient(60% 120% at 100% 100%, rgba(244,114,182,.16), transparent 60%), #111114';

// The top of the event detail: the name, the bill (headliners large, others smaller), and status pills.
// Sizes come from billing, never from list order.
export function PosterHeader({ title, dateText, event, state, seen, cited }: Props) {
  const bill = billLines(seen, cited);
  const where = [event.venue, event.city].filter(Boolean).join(', ');
  return (
    <header className="relative space-y-2 overflow-hidden rounded-2xl border border-zinc-800 p-5" style={{ background: POSTER_BACKGROUND }}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-zinc-300">{[dateText, where].filter(Boolean).join(' · ')}</p>
        {event.rating ? <p className="shrink-0 text-sm text-amber-300" aria-label={`Rated ${event.rating} of 5`}>{'★'.repeat(event.rating)}<span className="text-zinc-600">{'★'.repeat(5 - event.rating)}</span></p> : null}
      </div>
      <h2 className="text-2xl font-bold leading-tight text-zinc-50">{title}</h2>
      {bill.large.length > 0 && <p className="text-3xl font-bold uppercase leading-none tracking-tight text-zinc-50">{bill.large.map((a) => a.name).join(', ')}</p>}
      {bill.medium.length > 0 && <p className="text-base font-medium text-zinc-200">{bill.medium.map((a) => a.name).join(', ')}</p>}
      {bill.more > 0 && <p className="text-xs font-medium text-zinc-400">+ {bill.more} more</p>}
      <div className="flex flex-wrap gap-2 pt-2">
        <Pill tone="accent">{STATUS[state]}</Pill>
        {cited.length > 0 && <Pill>Lineup · {cited.length} acts</Pill>}
      </div>
    </header>
  );
}

// What the event still needs, as chips, with a guided Next that goes to the first gap. Nothing left reads "All filled in".
export function ThingsLeft({ gaps, onNext }: { gaps: Gap[]; onNext: (gap: Gap) => void }) {
  if (gaps.length === 0) {
    return (
      <p className="flex items-center gap-1 text-sm text-emerald-300">
        <Check className="h-4 w-4" aria-hidden="true" /> All filled in
      </p>
    );
  }
  return (
    <section aria-label="Still to fill in" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Still to fill in</p>
        <button
          type="button"
          onClick={() => onNext(gaps[0])}
          className="inline-flex h-11 items-center gap-1 rounded-control bg-violet-500 px-3 text-sm font-semibold text-white hover:bg-violet-400 sm:h-9"
        >
          Next: {GAP_QUESTION[gaps[0]]} <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {gaps.map((g) => (
          <li key={g}>
            <Pill>{GAP_LABEL[g]}</Pill>
          </li>
        ))}
      </ul>
    </section>
  );
}
