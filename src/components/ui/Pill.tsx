import type { ReactNode } from 'react';

// A small rounded label for a short fact, such as a series name or a status.
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) {
  const style = tone === 'accent' ? 'border-violet-500/40 bg-violet-500/10 text-violet-200' : 'border-zinc-700 bg-zinc-800/60 text-zinc-300';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs leading-4 ${style}`}>{children}</span>;
}
