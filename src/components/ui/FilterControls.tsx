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
    className={`field-sizing-content max-w-[14rem] cursor-pointer truncate rounded-full border py-1 pl-3 pr-2 text-xs focus:border-violet-500 focus:outline-none ${
      value ? 'border-violet-500/70 bg-violet-600/20 text-violet-100' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
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
    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
      value === 'yes'
        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
        : value === 'no'
          ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
          : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
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
    className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm ${
      open ? 'border-violet-500 text-violet-200' : 'border-zinc-800 text-zinc-300 hover:text-zinc-100'
    }`}
  >
    <SlidersHorizontal className="h-3.5 w-3.5" /> Filters{count ? ` (${count})` : ''}
  </button>
);

// The panel that holds the pills. Pills wrap, and the panel only shows when open.
export const FilterPanel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="space-y-2.5 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">{children}</div>
);
