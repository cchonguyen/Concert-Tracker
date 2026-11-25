import React from 'react';
import { Check, Minus, SlidersHorizontal } from 'lucide-react';

// The filter controls shared by the Table, Map and Timeline, so the same filter
// looks and behaves the same on each Explore page. Filters sit behind one
// Filters button and open as a row of small pills.

// A filter as one small pill: it reads its own name until you pick a value,
// then shows the value, highlighted.
export const FilterSelect: React.FC<{
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}> = ({ name, value, onChange, options }) => (
  <select
    aria-label={name}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`field-sizing-content min-h-11 max-w-[14rem] cursor-pointer truncate rounded-full border py-1 pl-3 pr-2 text-xs focus:border-accent focus:outline-none sm:min-h-9 ${
      value ? 'border-accent-tint-line bg-accent-tint text-text' : 'border-line bg-surface-1 text-text-muted hover:text-text'
    }`}
  >
    <option value="">{name}</option>
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

// A yes or no filter as a chip that cycles: any, has it, doesn't have it.
export type YesNo = 'any' | 'yes' | 'no';
const NEXT: Record<YesNo, YesNo> = { any: 'yes', yes: 'no', no: 'any' };

export const FilterToggle: React.FC<{
  name: string;
  yes: string;
  no: string;
  value: YesNo;
  onChange: (v: YesNo) => void;
}> = ({ name, yes, no, value, onChange }) => (
  <button
    onClick={() => onChange(NEXT[value])}
    title="Tap to cycle: any, has it, doesn't"
    className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-2.5 py-1 text-xs sm:min-h-9 ${
      value === 'yes'
        ? 'border-good/45 bg-good/10 text-good'
        : value === 'no'
          ? 'border-warn/45 bg-warn/10 text-warn'
          : 'border-line text-text-muted hover:text-text'
    }`}
  >
    {value === 'yes' ? <Check className="h-3 w-3" /> : value === 'no' ? <Minus className="h-3 w-3" /> : null}
    {value === 'yes' ? yes : value === 'no' ? no : name}
  </button>
);

// The button that opens the filter row. It shows how many filters are set.
export const FilterButton: React.FC<{ open: boolean; count: number; onClick: () => void }> = ({ open, count, onClick }) => (
  <button
    onClick={onClick}
    aria-expanded={open}
    className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border px-3 text-sm sm:min-h-9 ${
      open ? 'border-accent text-accent' : 'border-line-strong text-text-muted hover:text-text'
    }`}
  >
    <SlidersHorizontal className="h-3.5 w-3.5" /> Filters{count ? ` (${count})` : ''}
  </button>
);

// The panel that holds the pills. Pills wrap, and the panel only shows when open.
export const FilterPanel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="space-y-2.5 rounded-card border border-line bg-surface-1 p-3">{children}</div>
);
