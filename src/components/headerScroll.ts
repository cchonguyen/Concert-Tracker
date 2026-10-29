import { useEffect, useRef, useState, type RefObject } from 'react';

// Hide the top bar while the page scrolls down, bring it back on the way up.
// Small jitters are ignored so the bar does not flicker on a trackpad.
const JITTER = 8;
// Near the top the bar always shows.
const TOP = 64;

export interface HeaderScrollState {
  visible: boolean;
  lastY: number;
}

export function nextHeaderScroll(prev: HeaderScrollState, y: number, keepOpen: boolean): HeaderScrollState {
  if (keepOpen || y <= TOP) return { visible: true, lastY: y };
  const delta = y - prev.lastY;
  if (Math.abs(delta) < JITTER) return prev;
  return { visible: delta < 0, lastY: y };
}

// Keeps the bar shown while focus is inside it, so an open Menu does not vanish.
export function useHideOnScroll(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true);
  const state = useRef<HeaderScrollState>({ visible: true, lastY: 0 });

  useEffect(() => {
    const onScroll = () => {
      const keepOpen = ref.current?.contains(document.activeElement) ?? false;
      state.current = nextHeaderScroll(state.current, window.scrollY, keepOpen);
      setVisible(state.current.visible);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [ref]);

  return visible;
}
