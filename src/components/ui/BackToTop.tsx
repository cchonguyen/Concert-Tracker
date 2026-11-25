import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { scrollBehavior } from '../../services/motion';

// Shown once the page has scrolled about one screen. A text pill, bottom right.
// On a phone it sits above the + (QuickAddFab), which is bottom right too.
export function showBackToTop(scrollY: number, viewportHeight: number): boolean {
  return scrollY > viewportHeight;
}

// The Table's wide layout scrolls inside its own box, not the window, so the
// pill listens to every scroll on the page (capture) and follows whichever
// element moved. Only a box taller than its own screen can scroll that far.
export function BackToTop() {
  const [show, setShow] = useState(false);
  const [box, setBox] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || t === document.documentElement || t === document.body || !(t instanceof HTMLElement)) {
        setBox(null);
        setShow(showBackToTop(window.scrollY, window.innerHeight));
        return;
      }
      if (t.scrollHeight <= t.clientHeight) return;
      setBox(t);
      setShow(showBackToTop(t.scrollTop, t.clientHeight));
    };
    onScroll(new Event('scroll'));
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  if (!show) return null;

  return (
    <button
      type="button"
      onClick={() => (box ?? window).scrollTo({ top: 0, behavior: scrollBehavior() })}
      aria-label="Back to top"
      className="fixed bottom-24 right-5 z-30 inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3.5 py-2 text-xs font-medium text-zinc-200 shadow-lg shadow-black/40 backdrop-blur hover:border-violet-500 hover:text-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 sm:bottom-5"
    >
      <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> Back to top
    </button>
  );
}
