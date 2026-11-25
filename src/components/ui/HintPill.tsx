import type { ReactNode } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { Equalizer } from './Equalizer';

export type HintTone = 'needs' | 'done' | 'busy' | 'info';

const TONE: Record<HintTone, string> = {
  needs: 'border-warn/45 text-warn',
  done: 'border-good/45 text-good',
  busy: 'border-accent-tint-line text-accent',
  info: 'border-line text-text-muted',
};

// A short outlined hint on a row: "Which weekend?", "42 to review", "Finding who played".
// Each tone has its own mark (a triangle, a tick, the equaliser), so it never rests on colour.
export function HintPill({ tone, children }: { tone: HintTone; children: ReactNode }) {
  return (
    <span className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2.5 text-xs font-semibold ${TONE[tone]}`}>
      {tone === 'needs' && <TriangleAlert className="h-3 w-3" strokeWidth={2.25} aria-hidden="true" />}
      {tone === 'done' && <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />}
      {tone === 'busy' && <Equalizer size="sm" />}
      {children}
    </span>
  );
}
