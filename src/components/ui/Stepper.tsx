import type { ReactNode } from 'react';
import { Check, Circle, Pause, X } from 'lucide-react';
import { Equalizer } from './Equalizer';
import type { LineupStep, LineupStepState } from '../../services/lineupProgress';

// Each state has an icon and a word, so the state is not shown by colour alone.
const STATE: Record<LineupStepState, { word: string; text: string; icon: ReactNode }> = {
  done: { word: 'done', text: 'text-text', icon: <Check className="h-3.5 w-3.5 text-good" aria-hidden="true" /> },
  active: { word: 'running', text: 'text-text', icon: <Equalizer size="sm" /> },
  paused: { word: 'paused', text: 'text-warn', icon: <Pause className="h-3.5 w-3.5 text-warn" aria-hidden="true" /> },
  failed: { word: 'failed', text: 'text-bad', icon: <X className="h-3.5 w-3.5 text-bad" aria-hidden="true" /> },
  ready: { word: 'needs you', text: 'text-text', icon: <Circle className="h-3.5 w-3.5 fill-accent text-accent" aria-hidden="true" /> },
  todo: { word: 'not started', text: 'text-text-muted', icon: <Circle className="h-3.5 w-3.5 text-text-faint" aria-hidden="true" /> },
};

// A vertical list of steps: each with its icon, its name, and its state written out.
export function Stepper({ steps, label }: { steps: LineupStep[]; label: string }) {
  return (
    <ol aria-label={label} className="space-y-1.5">
      {steps.map((s) => (
        <li key={s.label} className="flex items-center gap-2 text-sm">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">{STATE[s.state].icon}</span>
          <span className={STATE[s.state].text}>{s.label}</span>
          <span className="text-xs text-text-muted">{STATE[s.state].word}</span>
        </li>
      ))}
    </ol>
  );
}
