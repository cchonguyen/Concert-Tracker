import React, { useEffect } from 'react';
import { PartyPopper, X } from 'lucide-react';
import { milestoneLine } from '../services/milestones';
import { Button } from './ui/Button';

// Confetti is a small library, loaded only when a milestone fires. Reduce-motion users get the card alone.
export const MilestoneCard: React.FC<{ milestone: number; onSeeYear: () => void; onClose: () => void }> = ({ milestone, onSeeYear, onClose }) => {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;
    import('canvas-confetti').then(({ default: confetti }) => {
      if (cancelled) return;
      const end = Date.now() + 2000;
      const burst = () => {
        confetti({ particleCount: 40, spread: 70, origin: { x: Math.random(), y: 0.2 } });
        if (Date.now() < end && !cancelled) window.requestAnimationFrame(burst);
      };
      burst();
    });
    return () => {
      cancelled = true;
    };
  }, [milestone]);

  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,26rem)] -translate-x-1/2 items-start gap-3 rounded-2xl border border-violet-500/40 bg-zinc-900 p-4 shadow-xl">
      <PartyPopper className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-zinc-100">{milestoneLine(milestone)}</p>
        <Button variant="secondary" onClick={onSeeYear}>
          See your year
        </Button>
      </div>
      <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:text-zinc-100">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
};
