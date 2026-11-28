import type { ReactNode } from 'react';

// Each tone is a soft solid fill with no outline. Shape and size live per tone, so the billing look (highlight) can be a
// small square-cornered mono label while the rest stay rounded pills.
const TONES = {
  neutral: 'rounded-full text-xs bg-neutral-soft text-text-muted',
  accent: 'rounded-full text-xs bg-accent-tint text-text',
  good: 'rounded-full text-xs bg-good-soft text-text',
  warn: 'rounded-full text-xs bg-warn-soft text-text',
  info: 'rounded-full text-xs bg-neutral-soft text-text', // How a set was played (DJ, Live).
  highlight: 'rounded-[3px] text-[10px] font-mono uppercase tracking-[0.1em] bg-second text-on-second', // Billing, such as Headliner.
  inferred: 'rounded-full text-xs bg-neutral-soft hatch text-text-muted italic', // A value worked out from a stated reason, not typed or verified. The hatch replaces the old dashed outline.
};

// A small label for a short fact, such as a series name or a status. Good and warn always carry words too,
// so the state never rests on color alone.
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 leading-4 ${TONES[tone]}`}>{children}</span>;
}

// A small count in a soft or solid bubble, such as the number of active filters.
export function CountBubble({
  children,
  tone = 'soft',
  className = '',
}: {
  children: ReactNode;
  tone?: 'solid' | 'soft';
  className?: string;
}) {
  const toneClass = tone === 'solid' ? 'bg-accent-fill text-on-accent' : 'bg-neutral-soft text-text-muted';
  return (
    <span
      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[11px] font-semibold tabular-nums leading-none ${toneClass} ${className}`}
    >
      {children}
    </span>
  );
}
