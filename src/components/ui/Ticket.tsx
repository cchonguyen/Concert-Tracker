import { createContext, Fragment, useContext, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { NameSep } from './NameList';

// The ticket stub (docs/archive/ticket-stub.md). Presentational only: no data,
// no rules. The rules live in src/services/ticket.ts. Paper, perforation and notches are
// classes in src/index.css; text and spacing are Tailwind utilities here.
// Stub atoms are aria-hidden: StubSentence is the one plain sentence a screen reader reads.

export type TicketLayout = 'columns' | 'rows';
export type TicketSize = 'hero' | 'small';

const TicketContext = createContext<{ size: TicketSize; layout: TicketLayout }>({ size: 'hero', layout: 'columns' });

const DEFAULT_STUB_WIDTH: Record<TicketSize, number> = { hero: 230, small: 120 };

interface TicketProps {
  layout: TicketLayout;
  size: TicketSize;
  body: ReactNode;
  stub: ReactNode;
  stubWidth?: number; // px, columns only
  className?: string;
  label: string; // aria-label on the root, e.g. "Ticket for Mesa Lights Festival 2026"
  tearing?: boolean; // stub end torn away
  torn?: boolean; // stub end slightly askew
}

// The notches are real holes, placed where the tear meets the ticket's edge (src/index.css, .ticket-card).
export function Ticket({ layout, size, body, stub, stubWidth, className = '', label, tearing, torn }: TicketProps) {
  const columns = layout === 'columns';
  const width = stubWidth ?? DEFAULT_STUB_WIDTH[size];
  const style = columns ? ({ '--ticket-stub-w': `${width}px` } as CSSProperties) : undefined;
  const bodyPad = columns && size === 'hero' ? 'px-[26px] pt-[22px] pb-5' : 'px-4 pt-3.5 pb-3.5';
  const bodyGap = size === 'hero' ? 'gap-2.5' : 'gap-1.5';
  const motion = tearing ? 'ticket-tearing' : torn ? 'ticket-torn' : '';
  // Where the tear meets the edge: the stub's left edge (columns) or top edge (rows), kept current as the ticket resizes.
  const card = useRef<HTMLElement>(null);
  const stubRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = card.current;
    const st = stubRef.current;
    if (!el || !st) return;
    const place = () => {
      el.style.setProperty('--notch-x', `${st.offsetLeft}px`);
      el.style.setProperty('--notch-y', `${st.offsetTop}px`);
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [columns]);
  return (
    <TicketContext.Provider value={{ size, layout }}>
      <article
        ref={card}
        aria-label={label}
        style={style}
        className={`ticket-card ${columns ? 'ticket-cols' : 'ticket-rows'} relative grid min-w-0 border border-transparent text-text ${className}`}
      >
        <div className={`flex min-w-0 flex-col ${bodyGap} ${bodyPad}`}>{body}</div>
        <div ref={stubRef} className={`ticket-stub ${motion}`}>{stub}</div>
      </article>
    </TicketContext.Provider>
  );
}

// Kicker: mono uppercase line, items joined with " · ".
export function TicketKicker({ items }: { items: string[] }) {
  return (
    <div className="font-mono text-[11px] tracking-[0.16em] text-text-muted uppercase">{items.join(' · ')}</div>
  );
}

// Event line: serif italic, muted.
export function TicketEventLine({ children }: { children: ReactNode }) {
  return <div className="font-display text-[17px] leading-tight text-text-muted italic sm:text-[20px]">{children}</div>;
}

// Headline: big serif. An italic accent "&" sits between the first two names.
export function TicketHeadline({ names }: { names: string[] }) {
  const { size, layout } = useContext(TicketContext);
  const sizing =
    size === 'small' ? 'text-[26px]' : layout === 'rows' ? 'text-[34px]' : 'text-[clamp(30px,3.4vw,44px)]';
  return (
    <div className={`font-display leading-none tracking-[-0.02em] text-text ${sizing} [overflow-wrap:break-word] [text-wrap:balance]`}>
      {names.map((name, i) => (
        <Fragment key={`${i}-${name}`}>
          {i === 1 && <span className="px-[0.12em] text-accent italic">&amp;</span>}
          {i >= 2 && <NameSep />}
          {name}
        </Fragment>
      ))}
    </div>
  );
}

// Small line: muted 13.5px.
export function TicketSmallLine({ children }: { children: ReactNode }) {
  return <div className="text-[13.5px] leading-normal text-text-muted">{children}</div>;
}

// Facts: label and value pairs above a hairline in the perforation colour.
export function TicketFacts({ facts }: { facts: Array<{ k: string; v: string }> }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-[26px] gap-y-1.5 border-t border-perf pt-3">
      {facts.map((f) => (
        <div key={f.k} className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-[10px] tracking-[0.14em] text-text-faint">{f.k}</span>
          <span className="text-[14.5px] font-semibold">{f.v}</span>
        </div>
      ))}
    </div>
  );
}

// Admit: "ADMIT 3", or a big number under the word when big.
export function StubAdmit({ n, big = false }: { n: number; big?: boolean }) {
  return (
    <div aria-hidden="true" className="font-mono text-[13px] font-bold tracking-[0.14em] text-text">
      ADMIT{big ? <span className="block text-[34px] leading-none tracking-normal">{n}</span> : ` ${n}`}
    </div>
  );
}

// Short date: boxed mono digits, one box per part.
export function StubShortDate({ parts }: { parts: string[] }) {
  return (
    <div aria-hidden="true" className="flex font-mono font-bold text-text">
      {parts.map((p, i) => (
        <span key={i} className={`border border-text px-1.5 py-0.5 text-sm ${i > 0 ? 'border-l-0' : ''}`}>
          {p}
        </span>
      ))}
    </div>
  );
}

// Barcode: drawn from widths (not a scannable code). Even entries are bars, odd are gaps.
export function StubBarcode({ bars, height = 34 }: { bars: number[]; height?: number }) {
  return (
    <div aria-hidden="true" className="flex max-w-full items-stretch overflow-hidden" style={{ height }}>
      {bars.map((w, i) => (
        <i key={i} className={`block shrink-0 ${i % 2 === 0 ? 'bg-text' : ''}`} style={{ width: w }} />
      ))}
    </div>
  );
}

// Key and value pairs in a 2-column mono grid.
export function StubKV({ items }: { items: Array<{ k: string; v: string }> }) {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-x-3 gap-y-2">
      {items.map((it) => (
        <div key={it.k} className="flex flex-col gap-px">
          <span className="font-mono text-[9.5px] tracking-[0.16em] text-text-faint">{it.k}</span>
          <span className="font-sans text-xs font-semibold text-text">{it.v}</span>
        </div>
      ))}
    </div>
  );
}

// Stamp: a rotated, bordered label in the bad colour.
export function StubStamp({ lines }: { lines: string[] }) {
  return (
    <div
      aria-hidden="true"
      className="-rotate-[7deg] self-start border-2 border-bad px-2 py-1 text-center font-mono text-[10.5px] leading-tight font-bold tracking-[0.14em] text-bad"
    >
      {lines.map((l, i) => (
        <span key={i} className="block">
          {l}
        </span>
      ))}
    </div>
  );
}

export function StubCode({ text }: { text: string }) {
  return (
    <div aria-hidden="true" className="font-mono text-lg font-bold tracking-[0.08em] text-text">
      {text}
    </div>
  );
}

export function StubSerial({ text }: { text: string }) {
  return (
    <div aria-hidden="true" className="font-mono text-[10px] tracking-[0.12em] text-text-faint">
      {text}
    </div>
  );
}

// The one plain sentence for screen readers, e.g. "Admit 3, $189, went 2 November 2026."
export function StubSentence({ text }: { text: string }) {
  return <p className="sr-only">{text}</p>;
}
