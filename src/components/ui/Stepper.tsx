import type { ReactNode } from 'react';
import { Check, Circle, Loader2, Pause, X } from 'lucide-react';
import type { LineupStep, LineupStepState } from '../../services/lineupProgress';

// Each state has an icon and a word, so the state is not shown by colour alone.
const STATE: Record<LineupStepState, { word: string; text: string; icon: ReactNode }> = {
  done: { word: 'done', text: 'text-zinc-200', icon: <Check className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" /> },
  active: { word: 'running', text: 'text-zinc-100', icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-300 motion-reduce:animate-none" aria-hidden="true" /> },
  paused: { word: 'paused', text: 'text-amber-200', icon: <Pause className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" /> },
  failed: { word: 'failed', text: 'text-rose-200', icon: <X className="h-3.5 w-3.5 text-rose-300" aria-hidden="true" /> },
  ready: { word: 'needs you', text: 'text-violet-100', icon: <Circle className="h-3.5 w-3.5 fill-violet-400 text-violet-400" aria-hidden="true" /> },
  todo: { word: 'not started', text: 'text-zinc-400', icon: <Circle className="h-3.5 w-3.5 text-zinc-600" aria-hidden="true" /> },
};

// A vertical list of steps: each with its icon, its name, and its state written out.
export function Stepper({ steps, label }: { steps: LineupStep[]; label: string }) {
  return (
    <ol aria-label={label} className="space-y-1.5">
      {steps.map((s) => (
        <li key={s.label} className="flex items-center gap-2 text-sm">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">{STATE[s.state].icon}</span>
          <span className={STATE[s.state].text}>{s.label}</span>
          <span className="text-xs text-zinc-400">{STATE[s.state].word}</span>
        </li>
      ))}
    </ol>
  );
}
