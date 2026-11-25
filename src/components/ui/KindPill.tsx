import { Mic, Tent, HelpCircle } from 'lucide-react';

export type EventKind = 'festival' | 'show' | 'unknown';

const KIND = {
  festival: { label: 'Festival', Icon: Tent, look: 'bg-accent-tint text-accent' },
  show: { label: 'Show', Icon: Mic, look: 'bg-surface-3 text-text-muted' },
  unknown: { label: 'Type not known', Icon: HelpCircle, look: 'bg-surface-3 text-text-faint' },
} as const;

// The event's kind as an icon and a word (pairs with the Ledger edge bar).
// "unknown" says so in words; the app never guesses a kind.
export function KindPill({ kind, size = 'md' }: { kind: EventKind; size?: 'sm' | 'md' }) {
  const k = KIND[kind];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-[7px] ${size === 'sm' ? 'h-[22px] px-1.5 text-[11.5px]' : 'h-[26px] px-2 text-xs'} ${k.look}`}>
      <k.Icon className={size === 'sm' ? 'h-3 w-3' : 'h-[13px] w-[13px]'} strokeWidth={2} aria-hidden="true" />
      {k.label}
    </span>
  );
}
