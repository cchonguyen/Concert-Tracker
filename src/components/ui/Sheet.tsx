import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import { X } from 'lucide-react';

// One API for two shapes: a sheet rising from the bottom on a phone (up to 92% of the height), and a card over the
// page on a wider screen. Escape and a tap on the backdrop close it, and focus goes back to what opened it.
// Swipe to close and the full-screen split view belong to DetailShell.
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    // Captured before the page sees it, and stopped, so an open Dialog behind the sheet does not close as well.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      opener?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default bg-black/60" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col rounded-t-card border-t border-line bg-surface-1 pb-[env(safe-area-inset-bottom)] shadow-2xl focus:outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card sm:border"
      >
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-line-strong" />
        </div>
        <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-2">
          <h3 className="min-w-0 truncate poster-head text-2xl text-text">{title}</h3>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="space-y-4 overflow-y-auto overscroll-contain px-4 pb-5">{children}</div>
      </div>
    </div>
  );
}
