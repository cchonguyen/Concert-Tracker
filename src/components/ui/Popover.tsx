import { useEffect, useRef, useState, type ReactNode } from 'react';

// The one look for anchored panels and hover cards (heatmap days, stats bars).
export const POPOVER_PANEL = 'rounded-card border border-line bg-surface-2 p-3 text-left text-sm text-text shadow-xl shadow-black/30';

interface Props {
  content: ReactNode;
  label: string; // The trigger's name for screen readers.
  children: ReactNode; // The trigger. Give it a button or focusable element so Enter works.
  className?: string;
  closeOnPick?: boolean; // Closes when something in the panel is pressed, for a small menu.
  align?: 'center' | 'start' | 'end'; // 'start' or 'end' pins the panel to the trigger's left or right edge, for triggers near a row's edge.
}

// An anchored panel. A mouse opens it on hover and a touch opens it on tap.
// Clicking or tapping pins it open until an outside tap or Escape.
export function Popover({ content, label, children, className = '', align = 'center', closeOnPick = false }: Props) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  // A short delay before a hover closes, so sweeping the pointer from the trigger to the panel does not drop it.
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const fine = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <span
      ref={box}
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => {
        if (!fine) return;
        window.clearTimeout(closeTimer.current);
        setOpen(true);
      }}
      onMouseLeave={() => {
        if (!fine || pinned) return;
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setOpen(false), 200);
      }}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          setPinned(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
            setPinned(true);
          }
        }}
        className="inline-flex h-full w-full cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {children}
      </span>
      {open && (
        <span
          role="dialog"
          aria-label={label}
          onClick={(e) => {
            if (closeOnPick && (e.target as HTMLElement).closest('button')) {
              setOpen(false);
              setPinned(false);
            }
          }}
          // The panel's top padding bridges the trigger and the card, so there is no gap where the pointer leaves the box.
          className={`absolute top-full z-30 w-64 pt-1 ${align === 'end' ? 'right-0' : align === 'start' ? 'left-0' : 'left-1/2 -translate-x-1/2'}`}>
          <span className={`block ${POPOVER_PANEL}`}>{content}</span>
        </span>
      )}
    </span>
  );
}
