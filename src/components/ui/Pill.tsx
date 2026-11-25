import type { ReactNode } from 'react';

const TONES = {
  neutral: 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
  accent: 'border-violet-500/50 bg-violet-500/15 text-violet-200',
  good: 'border-emerald-400/35 text-emerald-300',
  warn: 'border-amber-400/40 text-amber-300',
  info: 'border-sky-400/40 bg-sky-400/10 text-sky-300', // How a set was played (DJ, Live).
  highlight: 'border-amber-400/40 bg-amber-400/10 text-amber-200', // Billing, such as Headliner.
  inferred: 'border-dashed border-zinc-500 text-zinc-400 italic', // A value worked out from a stated reason, not typed or verified.
};

// A small rounded label for a short fact, such as a series name or a status. Good and warn always carry words too,
// so the state never rests on color alone.
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-4 ${TONES[tone]}`}>{children}</span>;
}
