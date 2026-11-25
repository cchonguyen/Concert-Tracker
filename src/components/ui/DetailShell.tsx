import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronUp, Maximize2, X } from 'lucide-react';
import { neighbours, nextWithGap } from '../../services/detailNav';
import { motion, useReducedMotion } from 'motion/react';
import { IconButton } from './IconButton';

// One row of the list an event sits in: its title, its date text and how many things it is missing.
export interface DetailRow {
  id: string;
  title: string;
  date: string;
  gaps: number;
}

interface Props {
  title: string;
  rows: DetailRow[]; // The list the open event came from, in the order it shows.
  openId: string;
  closeDisabled?: boolean; // True while a step on top (the lineup review) must answer Escape and taps instead.
  status?: ReactNode; // Left of the header: whether edits are saved.
  hero?: ReactNode; // Edge to edge above the padded content: the poster.
  onGo: (id: string) => void;
  onClose: () => void;
  children: ReactNode;
}

type Mode = 'split' | 'slide' | 'sheet';

// Split from 1100px, slide-over from 768px, bottom sheet below that (the widths in ARCHITECTURE.md).
const modeNow = (): Mode => {
  if (window.matchMedia('(min-width: 1100px)').matches) return 'split';
  if (window.matchMedia('(min-width: 768px)').matches) return 'slide';
  return 'sheet';
};

function useMode(): Mode {
  const [mode, setMode] = useState<Mode>(modeNow);
  useEffect(() => {
    const queries = [window.matchMedia('(min-width: 768px)'), window.matchMedia('(min-width: 1100px)')];
    const update = () => setMode(modeNow());
    queries.forEach((q) => q.addEventListener('change', update));
    return () => queries.forEach((q) => q.removeEventListener('change', update));
  }, []);
  return mode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Arrow keys belong to these controls (the Segmented choice, menus), so the list does not take them.
const ARROW_OWNERS = '[role="radiogroup"], [role="listbox"], [role="menu"], [role="tablist"], [role="switch"]';
const TYPING = 'input, textarea, select, [contenteditable="true"]';

// The newest open modal on the page. The shell answers keys only when it is this one.
const topModal = (): Element | null => {
  const all = document.querySelectorAll('[aria-modal="true"]');
  return all.length ? all[all.length - 1] : null;
};

// The event detail as one surface over the page: a split view with the list (desktop), a slide-over (small
// laptops and tablets) or a bottom sheet (phones). Moves between events in place, with keys and header buttons.
export function DetailShell({ title, rows, openId, closeDisabled = false, status, hero, onGo, onClose, children }: Props) {
  const mode = useMode();
  const panel = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const latest = useRef({ onGo, onClose, closeDisabled, rows, openId });
  latest.current = { onGo, onClose, closeDisabled, rows, openId };

  const ids = rows.map((r) => r.id);
  const { prev, next } = neighbours(ids, openId);
  const nextGap = nextWithGap(ids, openId, (id) => (rows.find((r) => r.id === id)?.gaps ?? 0) > 0);

  const close = () => {
    if (!latest.current.closeDisabled) latest.current.onClose();
  };

  // Locks the page behind the shell and moves focus into it.
  useEffect(() => {
    const pageOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.body.style.overflow = pageOverflow;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (topModal() !== panel.current) return;
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(TYPING)) return;
      const go = (id: string | null) => {
        if (id) latest.current.onGo(id);
      };
      const arrows = !target?.closest(ARROW_OWNERS);
      const { rows: list, openId: open } = latest.current;
      const ordered = list.map((r) => r.id);
      const before = neighbours(ordered, open);
      const gapNext = nextWithGap(ordered, open, (id) => (list.find((r) => r.id === id)?.gaps ?? 0) > 0);
      if (e.key === 'j' || e.key === 'J' || (arrows && e.key === 'ArrowDown')) go(before.next);
      else if (e.key === 'k' || e.key === 'K' || (arrows && e.key === 'ArrowUp')) go(before.prev);
      else if (e.key === 'n' || e.key === 'N') go(gapNext);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keeps Tab inside the shell while it is the top modal.
  useEffect(() => {
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel.current || topModal() !== panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = panel.current.contains(document.activeElement);
      if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab);
    return () => document.removeEventListener('keydown', onTab);
  }, []);

  // The open row is kept in view in the split list.
  useEffect(() => {
    listEl.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [openId]);

  // Sheet: a swipe down closes it, but only when the content was at its top when the swipe began.
  // On a phone the sheet follows a downward drag that starts at the top of its scroll; past 80 px it closes,
  // short of that it springs back.
  const still = useReducedMotion();
  const swipe = useRef<number | null>(null);
  const [drag, setDrag] = useState(0);
  const onTouchStart = (e: TouchEvent) => {
    swipe.current = scroller.current?.scrollTop === 0 ? e.touches[0].clientY : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (swipe.current === null) return;
    setDrag(Math.max(0, e.touches[0].clientY - swipe.current));
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    setDrag(0);
    if (start !== null && e.changedTouches[0].clientY - start > 80) close();
  };

  // Moving to another event fades the content in over 120 ms, so the swap reads as a change. It never waits.
  const shown = useRef(openId);
  useEffect(() => {
    if (shown.current === openId) return;
    shown.current = openId;
    if (!still) scroller.current?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
  }, [openId, still]);

  const settle = still ? { duration: 0 } : { type: 'spring' as const, stiffness: 420, damping: 40, mass: 0.8 };
  const enter =
    mode === 'sheet'
      ? { initial: still ? false : { y: '100%' }, animate: { y: drag }, transition: swipe.current !== null ? { duration: 0 } : settle }
      : mode === 'slide'
        ? { initial: still ? false : { x: '100%' }, animate: { x: 0 }, transition: settle }
        : {};

  const panelClass =
    mode === 'split'
      ? 'relative flex min-w-0 flex-1 flex-col bg-page'
      : mode === 'slide'
        ? 'absolute inset-y-0 right-0 flex w-[92%] flex-col border-l border-line-strong bg-page shadow-2xl'
        : 'absolute inset-x-0 bottom-0 flex h-[92vh] flex-col rounded-t-2xl border-t border-line-strong bg-page pb-[env(safe-area-inset-bottom)] shadow-2xl';

  // The split view's content is the Table's width (max-w-6xl in App), so the detail reads as part of the same page.
  const width = mode === 'split' ? 'max-w-6xl' : 'max-w-2xl';
  const bordered = 'border border-line-strong hover:border-accent-tint-line disabled:opacity-40';
  const navButton = `inline-flex h-11 items-center gap-0.5 rounded-control px-2.5 text-xs text-text hover:text-accent sm:h-9 ${bordered}`;
  const place = ids.indexOf(openId);

  const body = (
    <>
      {mode === 'split' ? (
        <nav aria-label="Events" className="flex w-[240px] shrink-0 flex-col border-r border-line-strong bg-surface-1 min-[1440px]:w-[280px]">
          <div className="flex items-center justify-between gap-2 border-b border-line py-1.5 pl-4 pr-2">
            <p className="font-mono text-xs font-medium tabular-nums text-text-muted">
              {rows.length} {rows.length === 1 ? 'event' : 'events'}
            </p>
            <IconButton icon={Maximize2} label="Back to the full list" onClick={close} disabled={closeDisabled} className={bordered} />
          </div>
          <div ref={listEl} className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((r) => {
              const open = r.id === openId;
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-current={open ? 'true' : undefined}
                  onClick={() => onGo(r.id)}
                  className={`flex w-full items-center gap-2 border-b border-l-[3px] border-b-line py-2.5 pl-3.5 pr-3 text-left ${
                    open ? 'border-l-accent-fill bg-surface-2' : 'border-l-transparent hover:bg-surface-2'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${open ? 'font-semibold text-text' : 'text-text'}`}>{r.title}</span>
                    <span className="block truncate font-mono text-[11px] text-text-muted">{r.date || 'No date yet'}</span>
                  </span>
                  {r.gaps > 0 ? (
                    <span
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-warn/45 px-1 font-mono text-[11px] font-semibold text-warn"
                      aria-label={`${r.gaps} missing`}
                    >
                      {r.gaps}
                    </span>
                  ) : (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-good/45" aria-label="Nothing missing">
                      <Check className="h-3 w-3 text-good" aria-hidden="true" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>
      ) : (
        <motion.button
          type="button"
          tabIndex={-1}
          aria-label="Close"
          onClick={close}
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: still ? 0 : 0.18 }}
          className="absolute inset-0 cursor-default bg-black/60"
        />
      )}

      <motion.section
        ref={panel}
        {...enter}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onTouchStart={mode === 'sheet' ? onTouchStart : undefined}
        onTouchMove={mode === 'sheet' ? onTouchMove : undefined}
        onTouchEnd={mode === 'sheet' ? onTouchEnd : undefined}
        className={`${panelClass} outline-none`}
      >
        {mode === 'sheet' && (
          <div className="flex justify-center pt-2" aria-hidden="true">
            <span className="h-1 w-10 rounded-full bg-line-strong" />
          </div>
        )}
        <header className="border-b border-line-strong bg-surface-1 px-3 py-1.5 sm:px-4">
          <div className="flex w-full items-center gap-1.5">
            <div className="min-w-0 flex-1">{status}</div>
            {place >= 0 && rows.length > 1 && (
              <p className="mr-1 hidden font-mono text-[11px] tabular-nums text-text-muted sm:block">
                {place + 1} of {rows.length} in your sort
              </p>
            )}
            <IconButton icon={ChevronUp} label="Previous event" disabled={!prev} onClick={() => prev && onGo(prev)} className={bordered} />
            <IconButton icon={ChevronDown} label="Next event" disabled={!next} onClick={() => next && onGo(next)} className={bordered} />
            <button type="button" disabled={!nextGap} onClick={() => nextGap && onGo(nextGap)} className={navButton}>
              Next with gaps <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <IconButton icon={X} label="Close" onClick={close} disabled={closeDisabled} className={bordered} />
          </div>
        </header>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {hero}
          <div className={`@container mx-auto w-full space-y-5 p-5 ${width}`}>{children}</div>
        </div>
      </motion.section>
    </>
  );

  // The split view is the Table's width, centred over a dimmed page, so the detail reads as part of the same page.
  if (mode === 'split') {
    return (
      <div
        className="fixed inset-0 z-40 flex justify-center bg-black/60 p-4"
        onMouseDown={(e) => {
          // A press on the dimmed page, outside the column, closes the detail, as a press on the slide-over's backdrop does.
          if (e.target === e.currentTarget) close();
        }}
      >
        <motion.div
          initial={still ? false : { opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: still ? 0 : 0.18, ease: 'easeOut' }}
          className="flex h-full w-full max-w-6xl overflow-hidden rounded-2xl border border-line-strong bg-page shadow-2xl"
        >
          {body}
        </motion.div>
      </div>
    );
  }
  return <div className="fixed inset-0 z-40 flex">{body}</div>;
}
