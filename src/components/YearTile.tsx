import React, { useEffect, useState } from 'react';
import type { YearReview } from '../services/stats';
import { barcodeBars } from '../services/ticket';
import { StubBarcode, StubSerial, Ticket, TicketKicker, TicketSmallLine } from './ui/Ticket';

interface YearTileProps {
  review: YearReview;
  cities: number;
  months: number[]; // shows per month, Jan to Dec (length 12)
  onOpen: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const WIDE = '(min-width: 640px)';

// Columns from 640px, rows on phones. Reads matchMedia so one ticket is rendered (no duplicate ids).
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

// Twelve thin bars, one per month, scaled to the busiest month. Decorative.
function SparkBars({ months }: { months: number[] }) {
  const max = Math.max(1, ...months);
  return (
    <div aria-hidden="true" className="flex h-10 items-end gap-1">
      {months.map((n, i) => (
        <span
          key={i}
          className={`block min-w-0 flex-1 ${n > 0 ? 'bg-accent' : 'bg-perf'}`}
          style={{ height: n > 0 ? `${Math.max(4, Math.round((n / max) * 40))}px` : '3px' }}
        />
      ))}
    </div>
  );
}

// "See your year" on Home: this year's shows, acts and cities, worked out from the same events as Stats.
// The share link is made in Stats (SharePanel), and it shares your whole history, not one year.
export const YearTile: React.FC<YearTileProps> = ({ review, cities, months, onOpen }) => {
  const wide = useWide();
  const line = [plural(review.events, 'show', 'shows'), plural(review.artists, 'act', 'acts'), plural(cities, 'city', 'cities')].join(' · ');

  const body = (
    <>
      <TicketKicker items={['Admit one', `Your ${review.year}`]} />
      <h2
        id="year-tile-title"
        className="font-display text-[28px] leading-none tracking-[-0.02em] text-text [text-wrap:balance] sm:text-[34px]"
      >
        {line}
      </h2>
      {review.topArtist && <TicketSmallLine>Most seen: {review.topArtist.label}</TicketSmallLine>}
      <SparkBars months={months} />
    </>
  );

  const stub = (
    <div className="flex h-full flex-col justify-between gap-3">
      <StubSerial text={`No. ${review.events}`} />
      <StubBarcode bars={barcodeBars(`year-${review.year}`)} height={34} />
      <button
        type="button"
        onClick={onOpen}
        className="min-h-11 self-start text-sm font-semibold text-accent hover:underline sm:min-h-9"
      >
        See your year ›
      </button>
    </div>
  );

  return (
    <Ticket
      layout={wide ? 'columns' : 'rows'}
      size="hero"
      stubWidth={150}
      label={`Your ${review.year} so far`}
      body={body}
      stub={stub}
    />
  );
};
