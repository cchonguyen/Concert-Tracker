import { useEffect, useId, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  const list = useRef<HTMLUListElement>(null);
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

  // Arrow keys, Home and End move between the choices. Opening from the keyboard puts focus on the current one.
  const optionButtons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
  const focusOption = (i: number) => {
    const all = optionButtons();
    if (all.length) all[(i + all.length) % all.length].focus();
  };
  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const all = optionButtons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') focusOption(at + 1);
    else if (e.key === 'ArrowUp') focusOption(at - 1);
    else if (e.key === 'Home') focusOption(0);
    else if (e.key === 'End') focusOption(all.length - 1);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    if (!open) return;
    const selected = list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    (selected ?? list.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
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
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="flex min-h-11 items-center gap-2 rounded-control border border-line bg-surface-1 px-3 text-sm text-text hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:min-h-9"
      >
        {CurrentIcon && <CurrentIcon className="h-4 w-4" />}
        <span>{current?.label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={label}
          onKeyDown={onListKey}
          className="absolute right-0 top-full z-30 mt-1.5 w-56 space-y-0.5 rounded-card border border-line bg-surface-1 p-1.5 shadow-xl shadow-black/30"
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
                className={`flex w-full items-center gap-2 min-h-11 rounded-control px-2.5 py-2 text-left text-sm hover:bg-surface-2 sm:min-h-9 ${
                  selected ? 'text-text' : 'text-text-muted'
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
