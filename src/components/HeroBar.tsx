import { Check } from 'lucide-react';
import type { AttendanceState } from '../server/events/attendance';
import type { Gap } from '../services/table';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';
import { Stars } from './ui/Stars';
import { ThingsLeft } from './PosterHeader';

const STATUS: Record<AttendanceState, { text: string; tone: 'good' | 'warn' | 'neutral' }> = {
  went: { text: 'Counted', tone: 'good' },
  upcoming: { text: 'Upcoming', tone: 'neutral' },
  confirm: { text: 'Did you go?', tone: 'warn' },
  missed: { text: "Didn't go", tone: 'neutral' },
};

interface Props {
  state: AttendanceState;
  confirmedBy: number; // How many sources confirm the date.
  lineupCount: number; // Acts on the lineup that are not cancelled.
  rating: number | null;
  onRate: (rating: number | null) => void;
  onShowSources: () => void; // Scrolls to the sources of the event.
  onWent: () => void; // "Yes, I went": counts the show and tears the stub.
  onMissed: () => void; // "No, I didn't go".
  gaps: Gap[];
  current: Gap | null;
  needsWeekend?: boolean;
  onPick: (gap: Gap) => void;
  onNext: () => void;
}

// One bar under the ticket: status, dates confirmed, the lineup, "Did you go?", stars and what is still to fill in.
// Buttons are at least 44px tall on phones.
export function HeroBar({
  state,
  confirmedBy,
  lineupCount,
  rating,
  onRate,
  onShowSources,
  onWent,
  onMissed,
  gaps,
  current,
  needsWeekend,
  onPick,
  onNext,
}: Props) {
  const status = STATUS[state];
  return (
    <section aria-label="Status and rating" className="space-y-3 border-b border-line-strong px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={status.tone}>
            {status.tone === 'good' && <Check className="h-3 w-3" aria-hidden="true" />}
            {status.text}
          </Pill>
          {confirmedBy > 0 && (
            <button
              type="button"
              onClick={onShowSources}
              className="inline-flex min-h-11 items-center rounded-full sm:min-h-9"
            >
              <Pill tone="good">
                Date confirmed by {confirmedBy} {confirmedBy === 1 ? 'source' : 'sources'}
              </Pill>
            </button>
          )}
          {lineupCount > 0 && <Pill tone="accent">Lineup · {lineupCount} acts, all cited</Pill>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {state === 'confirm' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" className="min-h-11 sm:min-h-9" onClick={onWent}>
                Yes, I went
              </Button>
              <Button className="min-h-11 sm:min-h-9" onClick={onMissed}>
                No, I didn't go
              </Button>
            </div>
          )}
          {/* Your rating: tap a star to rate, tap the current one again to clear it. */}
          <Stars value={rating} onChange={onRate} size="md" className="-ml-1.5" />
        </div>
      </div>
      {state === 'confirm' && <p className="text-xs text-text-muted">It's over, and it stays out of Stats, Artists and the Map until you say.</p>}
      {state === 'upcoming' && <p className="text-xs text-text-muted">Upcoming. Not counted until you say you went.</p>}
      <ThingsLeft gaps={gaps} current={current} needsWeekend={needsWeekend} onPick={onPick} onNext={onNext} />
    </section>
  );
}
