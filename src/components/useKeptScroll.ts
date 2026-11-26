import { useLayoutEffect, useRef } from 'react';

// Where each Manage list was scrolled to, by list. Kept for the page's life only.
const savedScroll = new Map<string, number>();

// A list that swaps itself for a detail (Manage records, archive artists, series, editions):
// opening the detail starts it at the top, and going back puts the list where it was.
// `listShown` is false while the detail is on screen; `ready` is false until the list's rows are there.
// The browser's own scroll restore is off while a list uses this, so it cannot jump first.
export function useKeptScroll(key: string, listShown: boolean, ready = true): void {
  const phase = useRef<'none' | 'list' | 'detail'>('none');

  useLayoutEffect(() => {
    const h = window.history;
    if (!('scrollRestoration' in h)) return;
    const before = h.scrollRestoration;
    h.scrollRestoration = 'manual';
    return () => {
      h.scrollRestoration = before;
    };
  }, []);

  useLayoutEffect(() => {
    if (!listShown) {
      if (phase.current === 'list') {
        phase.current = 'detail';
        window.scrollTo(0, 0);
      }
      return;
    }
    if (!ready) return;
    if (phase.current === 'detail') {
      const y = savedScroll.get(key);
      if (y !== undefined) window.scrollTo(0, y);
    }
    phase.current = 'list';
    savedScroll.set(key, window.scrollY);
    // Removed in a layout cleanup, before the shorter detail page can clamp the scroll and overwrite it.
    const onScroll = () => savedScroll.set(key, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [key, listShown, ready]);
}
