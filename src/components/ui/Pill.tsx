import type { ReactNode } from 'react';

const TONES = {
  neutral: 'border-line-strong bg-surface-2 text-text-muted',
  accent: 'border-accent-tint-line bg-accent-tint text-text',
  good: 'border-good/45 text-good',
  warn: 'border-warn/45 text-warn',
  info: 'border-line-strong text-text', // How a set was played (DJ, Live).
  highlight: 'border-warn/45 bg-warn/10 text-warn', // Billing, such as Headliner.
  inferred: 'border-dashed border-line-strong text-text-muted italic', // A value worked out from a stated reason, not typed or verified.
};

// A small rounded label for a short fact, such as a series name or a status. Good and warn always carry words too,
// so the state never rests on color alone.
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-4 ${TONES[tone]}`}>{children}</span>;
}
