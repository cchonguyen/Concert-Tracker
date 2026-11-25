import type { ReactNode, HTMLAttributes } from 'react';

// Joined, square-cornered rows (docs/specs/design-refresh-2.md, section 2, Shape).
// A Ledger holds Ledger.Row and Ledger.Separator children. Each row carries a
// 3 px straight edge bar on the left that names its kind: accent for a festival,
// grey for a show, amber for needs-you. The bar is always paired with an icon and
// a word in the row (a KindPill or HintPill), so the kind is never colour alone.

export type LedgerEdge = 'festival' | 'show' | 'needs' | 'none';

const EDGE: Record<LedgerEdge, string> = {
  festival: 'border-l-accent-fill',
  show: 'border-l-line-strong',
  needs: 'border-l-warn',
  none: 'border-l-transparent',
};

interface LedgerProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  // Drop the outer border when the ledger sits inside a panel that already has one.
  bare?: boolean;
}

export function Ledger({ children, bare = false, className = '', ...rest }: LedgerProps) {
  return (
    <div className={`flex flex-col ${bare ? '' : 'border border-line-strong'} bg-surface-1 ${className}`} {...rest}>
      {children}
    </div>
  );
}

interface RowProps extends HTMLAttributes<HTMLElement> {
  edge?: LedgerEdge;
  // A row that opens something is a button; one that only shows data is a plain block.
  onOpen?: () => void;
  selected?: boolean;
  children: ReactNode;
}

// Hover lifts the row one shade and widens the edge bar from 3 to 4 px (instant, no motion).
function Row({ edge = 'none', onOpen, selected = false, className = '', children, ...rest }: RowProps) {
  const look = `group flex w-full min-h-14 items-center gap-3 border-b border-l-[3px] border-b-line text-left ${EDGE[edge]} ${
    selected ? 'bg-surface-2' : ''
  } ${onOpen ? 'cursor-pointer hover:border-l-4 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent' : ''} ${className}`;
  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} aria-current={selected ? 'true' : undefined} className={look} {...(rest as HTMLAttributes<HTMLButtonElement>)}>
        {children}
      </button>
    );
  }
  return (
    <div className={look} {...(rest as HTMLAttributes<HTMLDivElement>)}>
      {children}
    </div>
  );
}

interface SeparatorProps {
  label: string; // "2026" or "No date yet"
  count?: number; // shown as "5 events"
  unit?: [singular: string, plural: string];
}

// A year separator: the year in heavy sans and the count in mono. Never month headers.
function Separator({ label, count, unit = ['event', 'events'] }: SeparatorProps) {
  return (
    <div role="heading" aria-level={3} className="flex items-baseline gap-2.5 border-b border-line px-3.5 pb-2 pt-3.5">
      <span className="text-lg font-extrabold tracking-tight text-text">{label}</span>
      {count !== undefined && (
        <span className="font-mono text-[11.5px] tabular-nums text-text-muted">
          {count} {count === 1 ? unit[0] : unit[1]}
        </span>
      )}
    </div>
  );
}

Ledger.Row = Row;
Ledger.Separator = Separator;
