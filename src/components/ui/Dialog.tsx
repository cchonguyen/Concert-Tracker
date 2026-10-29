import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string; // Read by screen readers as the dialog's name. Shown by the content, not here.
  onClose: () => void;
  placement?: 'side' | 'center';
  panelClassName?: string; // Replaces the default panel look, for panels that already have their own width and padding.
  children: ReactNode;
}

const SIDE_PANEL = 'flex h-full w-full max-w-xl flex-col border-l border-zinc-900 bg-zinc-950 shadow-2xl';
const CENTER_PANEL = 'w-full max-w-lg space-y-4 rounded-t-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl sm:rounded-2xl';

// Open dialogs, outermost first. Only the last one answers Escape and Tab.
const openDialogs: symbol[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A modal dialog shell: a side panel (side) or a centred card (center).
// While open it moves focus inside, keeps Tab inside, closes on Escape or an outside press, locks page scroll,
// and returns focus to the control that opened it.
export function Dialog({ title, onClose, placement = 'side', panelClassName, children }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const id = Symbol('dialog');
    openDialogs.push(id);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pageOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
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
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = pageOverflow;
      openDialogs.splice(openDialogs.indexOf(id), 1);
      opener?.focus();
    };
  }, []);

  const center = placement === 'center';
  return (
    <div
      className={center ? 'fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-start sm:pt-24' : 'fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm'}
      onMouseDown={() => closeRef.current()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={
          center
            ? `${panelClassName ?? CENTER_PANEL} outline-none`
            : `${panelClassName ?? SIDE_PANEL} outline-none`
        }
      >
        {children}
      </div>
    </div>
  );
}
