import { useId, useMemo, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  count?: number | string;
  // Phones show the icon alone for tabs that are not open, when there is one.
  compact?: boolean;
}

interface Props<T extends string> {
  label: string; // The row's name for screen readers, e.g. "Library pages".
  items: Array<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  // folder: square tabs on one line; the open tab joins the panel below it, with a raised
  // surface and a 2 px accent cap. underline: a quieter row with a straight 2 px underline.
  variant?: 'folder' | 'underline';
  // The surface of the panel the folder tabs join, so the open tab covers the line under it.
  panel?: 'page' | 'surface-1' | 'surface-2';
  className?: string;
  end?: ReactNode; // Anything that sits at the far end of the row (a button, a count).
  // false when the row sits on a line its container already draws (the app header).
  line?: boolean;
}

const PANEL_BG = { page: 'bg-page', 'surface-1': 'bg-surface-1', 'surface-2': 'bg-surface-2' } as const;
const PANEL_BORDER = { page: 'border-b-page', 'surface-1': 'border-b-surface-1', 'surface-2': 'border-b-surface-2' } as const;

// Navigation between pages or views (docs/archive/design-refresh-2.md, section 2, Shape).
// Square corners and straight borders, never the solid Add colour. The open tab is also
// bold, raised and marked with aria-current, so the state is never shown by colour alone.
// The open tab's folder (or the underline) slides to the new tab with a little overshoot and settles with a
// subtle squish, and the new tab's icon hops; with reduced motion it all moves at once.
export function Tabs<T extends string>({ label, items, value, onChange, variant = 'folder', panel = 'surface-1', className = '', end, line = true }: Props<T>) {
  const id = useId();
  const still = useReducedMotion();
  const slide = still ? { duration: 0 } : { type: 'spring' as const, stiffness: 141, damping: 13.75, mass: 0.7 };
  const folder = variant === 'folder';
  // Which way the last change went (-1 left, 1 right), so the icon hop leans the right way.
  const at = items.findIndex((t) => t.value === value);
  const last = useRef({ value, at, dir: 0, moved: false });
  if (last.current.value !== value) {
    last.current = { value, at, dir: Math.sign(at - last.current.at) || 1, moved: true };
  }
  const { dir, moved } = last.current;
  // Made once per change, so a re-render for another reason (a count ticking up) does not rock it again.
  const squish = useMemo(
    () =>
      still || !moved
        ? undefined
        : {
            scaleX: [1, 0.935, 1],
            scaleY: [1, 1.07, 1],
            transition: { duration: 0.58, times: [0, 0.35, 1], ease: 'easeInOut' as const },
          },
    [value, still],
  );
  const squash = useMemo(
    () => (still || !moved ? undefined : { scaleY: [1, 2.5, 1], transition: { duration: 0.58 } }),
    [value, still],
  );

  return (
    <nav
      aria-label={label}
      className={`flex items-end gap-0.5 overflow-x-auto ${line ? (folder ? 'border-b border-line-strong' : 'border-b border-line') : ''} ${folder ? 'px-1.5' : ''} ${className}`}
    >
      {items.map((t) => {
        const on = t.value === value;
        const Icon = t.icon;
        const base =
          'relative flex shrink-0 items-center gap-1.5 rounded-none px-3.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent min-h-11 sm:min-h-10';
        const look = folder
          ? on
            ? '-mb-px border border-transparent font-bold text-text'
            : 'border border-transparent border-b-0 font-medium text-text-muted hover:text-text'
          : on
            ? '-mb-px font-bold text-text'
            : '-mb-px font-medium text-text-muted hover:text-text';
        return (
          <button key={t.value} type="button" aria-current={on ? 'page' : undefined} aria-label={t.compact ? t.label : undefined} onClick={() => onChange(t.value)} className={`${base} ${look}`}>
            {on && folder && (
              <motion.span
                layoutId={`${id}-folder`}
                transition={slide}
                animate={squish}
                aria-hidden="true"
                style={{ originY: 1 }}
                className={`pointer-events-none absolute -inset-px border border-line-strong ${PANEL_BORDER[panel]} ${PANEL_BG[panel]}`}
              >
                <span className="absolute inset-x-0 top-0 h-0.5 bg-accent-fill" />
              </motion.span>
            )}
            {on && !folder && (
              <motion.span
                layoutId={`${id}-mark`}
                transition={slide}
                animate={squash}
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent-fill"
              />
            )}
            {Icon &&
              (on && moved && !still ? (
                <motion.span
                  key={`${t.value}-hop`}
                  className="relative inline-flex"
                  initial={{ y: -6, rotate: dir * -14, scale: 1.25 }}
                  animate={{ y: 0, rotate: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 203, damping: 8.75 }}
                >
                  <Icon className="h-[15px] w-[15px] text-accent" strokeWidth={1.75} aria-hidden="true" />
                </motion.span>
              ) : (
                <Icon className={`relative h-[15px] w-[15px] ${on ? 'text-accent' : ''}`} strokeWidth={1.75} aria-hidden="true" />
              ))}
            <span className={`relative ${t.compact && !on ? 'hidden sm:inline' : ''}`}>{t.label}</span>
            {t.count !== undefined && (
              <span
                className={`relative rounded-full px-1.5 font-mono text-[11px] tabular-nums ${
                  on ? 'bg-accent-tint text-text ring-1 ring-accent-tint-line' : 'bg-surface-3 text-text-muted'
                } ${t.compact && !on ? 'hidden sm:inline' : ''}`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
      {end && <div className="ml-auto flex items-center self-center pb-1">{end}</div>}
    </nav>
  );
}
