import { useRef, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  label: string; // The group's name for screen readers; the visible label sits above it.
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

// A row of options where exactly one is chosen. The chosen one has a tick as well as a colour, so the state is not shown by colour alone.
// Arrow keys move between options and choose the one they land on; Tab leaves the group.
export function Segmented<T extends string>({ label, options, value, onChange, className = '' }: Props<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const chosen = options.findIndex((o) => o.value === value);
  // The chosen option is the one Tab lands on; with none chosen, the first enabled one is.
  const tabStop = chosen >= 0 ? chosen : options.findIndex((o) => !o.disabled);

  const next = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + dir * k + n * k) % n;
      if (!options[i].disabled) return i;
    }
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = next(from, dir);
    buttons.current[i]?.focus();
    if (!options[i].disabled) onChange(options[i].value);
  };

  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex flex-wrap gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1 ${className}`}>
      {options.map((o, i) => {
        const on = i === chosen;
        return (
          <button
            key={o.value}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`inline-flex min-h-11 items-center gap-1 rounded-md px-3 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-8 ${
              on ? 'bg-violet-600/30 font-semibold text-violet-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {on && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
