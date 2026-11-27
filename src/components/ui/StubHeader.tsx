import { useLayoutEffect, useRef, type ReactNode } from 'react';

// Ticket header for tables and ranked lists (mockup 2b/2c, `.tt`). The header is the stub:
// a roomy paper band, then one large notched perforation, then the rows. Segments are
// separated by small dashed perforations. Phone (under 560px) keeps the title and the
// segments not marked hideOnPhone. The perforation is decorative.

interface Segment {
  k: string;
  v: ReactNode;
  hideOnPhone?: boolean;
}

interface StubHeaderProps {
  title: ReactNode;
  kicker?: string;
  segments?: Segment[];
  titleSize?: 'normal' | 'large';
  children: ReactNode;
  className?: string;
}

// Under 560px the padding is 20px 16px; from 560px it is 26px 28px. Tailwind's min-[560px] matches that.
export function StubHeader({
  title,
  kicker,
  segments = [],
  titleSize = 'normal',
  children,
  className = '',
}: StubHeaderProps) {
  // The notches are real holes where the perforation meets the edges (src/index.css, .stub-header), placed at the
  // bottom of the paper band and kept current as it resizes.
  const box = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const band = paper.current;
    if (!el || !band) return;
    const place = () => el.style.setProperty('--tear-y', `${band.offsetHeight}px`);
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(band);
    return () => ro.disconnect();
  }, []);
  const titleClass = titleSize === 'large' ? 'text-[32px] min-[560px]:text-[40px]' : 'text-[24px] min-[560px]:text-[30px]';
  return (
    <div ref={box} className={`stub-header relative flex min-w-0 flex-col border border-transparent ${className}`}>
      <div ref={paper} className="ticket-paper flex min-w-0 items-stretch">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-4 py-5 min-[560px]:px-7 min-[560px]:py-[26px]">
          {kicker && <span className="font-mono text-[10.5px] tracking-[0.16em] text-text-muted uppercase">{kicker}</span>}
          <div className={`min-w-0 poster-head text-text [overflow-wrap:anywhere] ${titleClass}`}>
            {title}
          </div>
        </div>
        {segments.map((s) => (
          <div
            key={s.k}
            className={`flex-col items-center justify-center gap-1.5 border-l border-dashed border-perf px-4 py-5 text-center min-[560px]:px-6 min-[560px]:py-[26px] ${
              s.hideOnPhone ? 'hidden min-[560px]:flex' : 'flex'
            }`}
          >
            <span className="font-mono text-[10.5px] tracking-[0.16em] text-text-muted">{s.k}</span>
            <span className="font-mono text-[26px] leading-none font-bold text-text">{s.v}</span>
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="stub-perf" />
      <div className="min-w-0 pt-1.5">{children}</div>
    </div>
  );
}
