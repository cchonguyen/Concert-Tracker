import React, { useEffect } from 'react';
import { PartyPopper, X } from 'lucide-react';
import { Button } from './ui/Button';
import { burstConfetti } from './ui/confetti';
import { prefersReducedMotion } from '../services/motion';

// Confetti runs once per card and never under reduced motion; the card alone is enough then.
export const MilestoneCard: React.FC<{ line: string; actionLabel: string; onAction: () => void; onClose: () => void }> = ({ line, actionLabel, onAction, onClose }) => {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    return burstConfetti();
  }, [line]);

  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,26rem)] -translate-x-1/2 items-start gap-3 rounded-card border border-accent-tint-line bg-surface-1 p-4 text-text shadow-xl">
      <PartyPopper className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-text">{line}</p>
        <Button variant="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
      <button
        onClick={onClose}
        aria-label="Close"
        className="flex min-h-10 min-w-10 items-center justify-center rounded-control text-text-muted hover:text-text"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
};
