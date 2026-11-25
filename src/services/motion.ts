// Reduced motion (docs/specs/design-refresh-2.md, section 4): with the system
// setting on, nothing glides, pulses or celebrates. CSS animations are
// stopped by the rule at the end of index.css; this covers motion started
// from code, such as scrolling.

type MatchMedia = (query: string) => { matches: boolean };

const browserMatch = (): MatchMedia | undefined =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined;

export function prefersReducedMotion(match: MatchMedia | undefined = browserMatch()): boolean {
  return match ? match('(prefers-reduced-motion: reduce)').matches : false;
}

// 'smooth' normally, 'auto' (an instant jump) when reduced motion is on.
export function scrollBehavior(match?: MatchMedia): ScrollBehavior {
  return prefersReducedMotion(match ?? browserMatch()) ? 'auto' : 'smooth';
}
