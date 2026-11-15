import { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { LoggedEvent, SeenAct } from '../server/events/types';
import type { AttendanceState } from '../server/events/attendance';
import { billLines, GAP_LABEL, gapQuestion } from '../services/poster';
import type { Gap } from '../services/table';
import { Pill } from './ui/Pill';

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

// Your rating as five stars in the poster's corner. The empty ones stay faint, so an unrated show still shows the row;
// tapping a star rates, and tapping the current rating again clears it. Hovering or focusing a star lights stars up to it,
// so you see the rating you are about to give.
function Stars({ rating, onRate }: { rating?: number; onRate: (rating: number | null) => void }) {
  const filled = Math.max(0, Math.min(5, Math.round(rating ?? 0)));
  const [preview, setPreview] = useState<number | null>(null);
  const lit = preview ?? filled;
  return (
    <div
      role="group"
      aria-label={filled ? `Your rating: ${filled} of 5` : 'Your rating: not rated yet'}
      className="-mr-1.5 -mt-1.5 flex shrink-0"
      onMouseLeave={() => setPreview(null)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
          aria-pressed={n === filled}
          onClick={() => onRate(n === filled ? null : n)}
          onMouseEnter={() => setPreview(n)}
          onFocus={() => setPreview(n)}
          onBlur={() => setPreview(null)}
          className={`flex h-11 w-8 items-center justify-center text-xl leading-none transition-colors sm:h-8 sm:w-7 ${
            n <= lit ? 'text-amber-300' : 'text-zinc-600 hover:text-amber-300/70'
          }`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// The top of the event detail, edge to edge like a gig poster: the date and place, the event's name, the bill
// (headliners on the bigger line, everyone else on the smaller one) and status pills. Sizes come from billing,
// never from list order.
export function PosterHeader({ title, label, event, state, seen, cited, confirmedBy, onRate }: Props) {
  const bill = billLines(seen, cited);
  const small = [...bill.medium.map((a) => a.name), ...(bill.more > 0 ? [`+ ${bill.more} more`] : [])];
  const status = STATUS[state];
  return (
    <header className="poster-bg space-y-2 border-b border-zinc-800 px-5 pb-5 pt-6">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">{label}</p>
        <Stars rating={event.rating} onRate={onRate} />
      </div>
      <h2 className="text-3xl font-extrabold uppercase leading-none tracking-tight text-zinc-50 sm:text-4xl">{title}</h2>
      {bill.large.length > 0 && <p className="text-lg font-medium leading-snug text-zinc-100">{bill.large.map((a) => a.name).join(' · ')}</p>}
      {small.length > 0 && <p className="text-sm font-medium text-zinc-400">{small.join(' · ')}</p>}
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
        {state === 'upcoming' && <p className="text-xs text-zinc-400 sm:text-right">Upcoming. Not counted until you say you went.</p>}
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
      <p className="flex items-center gap-1.5 rounded-xl border border-emerald-400/30 px-4 py-2.5 text-sm text-emerald-300">
        <Check className="h-4 w-4" aria-hidden="true" /> All filled in
      </p>
    );
  }
  return (
    <section aria-label="Still to fill in" className="flex flex-wrap items-center gap-2 rounded-xl border border-violet-500/40 bg-violet-500/[0.06] px-3 py-2">
      <p className="text-sm font-semibold text-zinc-100">
        {gaps.length} {gaps.length === 1 ? 'thing' : 'things'} left
      </p>
      <span className="text-zinc-600" aria-hidden="true">
        ·
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {gaps.map((g) => (
          <li key={g}>
            <button
              type="button"
              aria-pressed={g === current}
              onClick={() => onPick(g)}
              className={`min-h-11 rounded-full border px-3 text-sm sm:min-h-9 ${
                g === current ? 'border-violet-400 bg-violet-500/20 text-violet-100' : 'border-zinc-700 text-zinc-300 hover:border-violet-500'
              }`}
            >
              {GAP_LABEL[g]}
            </button>
          </li>
        ))}
      </ul>
      {current && <span className="min-w-0 text-sm text-violet-100">{gapQuestion(current, { needsWeekend })}</span>}
      <span className="grow" />
      <button
        type="button"
        onClick={onNext}
        className="inline-flex min-h-11 items-center gap-0.5 rounded-control bg-violet-500 px-3 text-sm font-semibold text-white hover:bg-violet-400 sm:min-h-9"
      >
        Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
