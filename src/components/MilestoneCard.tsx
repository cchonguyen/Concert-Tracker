import React, { useEffect } from 'react';
import { PartyPopper, X } from 'lucide-react';
import { Button } from './ui/Button';
import { burstConfetti } from './ui/confetti';

// Confetti runs once per card and never under reduced motion; the card alone is enough then.
export const MilestoneCard: React.FC<{ line: string; actionLabel: string; onAction: () => void; onClose: () => void }> = ({ line, actionLabel, onAction, onClose }) => {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    return burstConfetti();
  }, [line]);

  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,26rem)] -translate-x-1/2 items-start gap-3 rounded-2xl border border-violet-500/40 bg-zinc-900 p-4 shadow-xl">
      <PartyPopper className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-zinc-100">{line}</p>
        <Button variant="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
      <button onClick={onClose} aria-label="Close" className="rounded-md p-2.5 text-zinc-400 hover:text-zinc-100">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
};
