import { Check } from 'lucide-react';
import type { LoggedEvent, SeenAct } from '../server/events/types';
import type { AttendanceState } from '../server/events/attendance';
import { billLines, GAP_LABEL } from '../services/poster';
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

// The top of the event detail: the name, the bill (headliners large, others smaller), and status pills.
// Sizes come from billing, never from list order.
export function PosterHeader({ title, dateText, event, state, seen, cited }: Props) {
  const bill = billLines(seen, cited);
  const where = [event.venue, event.city].filter(Boolean).join(', ');
  return (
    <header className="space-y-3 rounded-2xl border border-zinc-800 bg-gradient-to-br from-violet-500/20 via-zinc-900 to-zinc-950 p-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-zinc-100">{title}</h2>
        {(dateText || where) && <p className="text-sm text-zinc-300">{[dateText, where].filter(Boolean).join(' · ')}</p>}
      </div>
      {bill.large.length > 0 && <p className="text-2xl font-semibold leading-tight text-zinc-50">{bill.large.map((a) => a.name).join(', ')}</p>}
      {bill.medium.length > 0 && <p className="text-base text-zinc-200">{bill.medium.map((a) => a.name).join(', ')}</p>}
      {bill.more > 0 && <p className="text-xs text-zinc-400">+ {bill.more} more</p>}
      <div className="flex flex-wrap gap-2">
        <Pill tone="accent">{STATUS[state]}</Pill>
        {cited.length > 0 && <Pill>Lineup: {cited.length} acts</Pill>}
      </div>
    </header>
  );
}

// What the event still needs, as chips. Nothing left reads "All filled in".
export function ThingsLeft({ gaps }: { gaps: Gap[] }) {
  if (gaps.length === 0) {
    return (
      <p className="flex items-center gap-1 text-sm text-emerald-300">
        <Check className="h-4 w-4" aria-hidden="true" /> All filled in
      </p>
    );
  }
  return (
    <section aria-label="Still to fill in" className="space-y-2">
      <p className="text-xs uppercase tracking-wide text-zinc-400">Still to fill in</p>
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
