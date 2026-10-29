import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tooltip } from './Tooltip';

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  hint?: string; // Shown on hover or focus, for a choice whose name alone is not clear.
}

interface Props<T extends string> {
  label: string; // Names the control for screen readers, e.g. "Manage section".
  value: T;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

// A button that shows the current choice and opens a list of the others.
// Closes on a pick, an outside tap or Escape.
export function MenuButton<T extends string>({ label, value, options, onChange, className = '' }: Props<T>) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];
  const CurrentIcon = current?.icon;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={`${label}: ${current?.label ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200 hover:border-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
      >
        {CurrentIcon && <CurrentIcon className="h-4 w-4" />}
        <span>{current?.label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute right-0 top-11 z-30 w-56 space-y-0.5 rounded-xl border border-zinc-800 bg-zinc-900 p-1.5 shadow-xl shadow-black/30"
        >
          {options.map((o) => {
            const Icon = o.icon;
            const selected = o.value === value;
            const option = (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-zinc-800 ${
                  selected ? 'text-zinc-100' : 'text-zinc-400'
                }`}
              >
                {Icon && <Icon className="h-3.5 w-3.5" />}
                {o.label}
              </button>
            );
            return <li key={o.value}>{o.hint ? <Tooltip label={o.hint} className="w-full">{option}</Tooltip> : option}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
