import { useId, useRef, type KeyboardEvent } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Shown before the label; with `iconOnly` on the group, it stands in for the label (which stays the button's name). */
  icon?: LucideIcon;
}

interface Props<T extends string> {
  label: string; // The group's name for screen readers; the visible label sits above it.
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  // Smaller segments for a narrow row. On phones the chosen one is marked by its fill and bold text, without the tick.
  compact?: boolean;
  // Options share the row's width equally (a full-width row on a phone).
  stretch?: boolean;
  // Icons only, with no tick: the label becomes the button's name and tooltip.
  iconOnly?: boolean;
}

// A row of options where exactly one is chosen. The chosen one has a tick as well as a colour, so the state is not shown by colour alone.
// Arrow keys move between options and choose the one they land on; Tab leaves the group.
export function Segmented<T extends string>({ label, options, value, onChange, className = '', compact = false, stretch = false, iconOnly = false }: Props<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  // The chosen fill slides to the new option with a little bounce; with reduced motion it moves at once.
  const id = useId();
  const still = useReducedMotion();
  const slide = still ? { duration: 0 } : { type: 'spring' as const, stiffness: 105, damping: 13, mass: 0.7 };
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
    <div role="radiogroup" aria-label={label} className={`inline-flex flex-wrap gap-1 rounded-control border border-line bg-surface-1 p-1 ${className}`}>
      {options.map((o, i) => {
        const on = i === chosen;
        const Icon = o.icon;
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
            aria-label={iconOnly ? o.label : undefined}
            title={iconOnly ? o.label : undefined}
            className={`relative inline-flex min-h-11 items-center gap-1 rounded-control ${stretch ? 'flex-1 justify-center whitespace-nowrap' : ''} ${compact ? 'px-2 text-xs sm:px-3 sm:text-sm' : 'px-3 text-sm'} transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-9 ${
              on ? 'font-semibold text-text' : 'text-text-muted hover:text-text'
            }`}
          >
            {on && <motion.span layoutId={`${id}-fill`} transition={slide} aria-hidden="true" className="absolute inset-0 rounded-control bg-accent-tint" />}
            {on && !iconOnly && <Check className={`relative h-3.5 w-3.5 ${compact ? 'hidden sm:block' : ''}`} aria-hidden="true" />}
            {Icon && <Icon className="relative h-3.5 w-3.5" aria-hidden="true" />}
            {!iconOnly && <span className="relative">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
