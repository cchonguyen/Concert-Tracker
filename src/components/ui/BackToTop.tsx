import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

// Shown once the page has scrolled about one screen. Bottom left, so it does
// not sit on the phone's floating + (bottom right).
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
      title="Back to top"
      aria-label="Back to top"
      className="fixed bottom-5 left-4 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/95 text-zinc-300 shadow-lg shadow-black/30 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
    >
      <ArrowUp className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
