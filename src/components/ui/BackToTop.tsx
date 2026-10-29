import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

// Shown once the page has scrolled about one screen. A text pill, bottom right.
// On a phone it sits above the + (QuickAddFab), which is bottom right too.
export function showBackToTop(scrollY: number, viewportHeight: number): boolean {
  return scrollY > viewportHeight;
}

export function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(showBackToTop(window.scrollY, window.innerHeight));
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!show) return null;

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
      className="fixed bottom-24 right-5 z-30 inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3.5 py-2 text-xs font-medium text-zinc-200 shadow-lg shadow-black/40 backdrop-blur hover:border-violet-500 hover:text-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 sm:bottom-5"
    >
      <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> Back to top
    </button>
  );
}
