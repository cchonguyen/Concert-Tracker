import React from 'react';
import { Archive } from 'lucide-react';
import type { YearReview } from '../services/stats';
import { Button } from './ui/Button';

interface YearTileProps {
  review: YearReview;
  cities: number;
  onOpen: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "See your year" on Home: this year's shows, acts and cities, worked out from the same events as Stats.
// The share link is made in Stats (SharePanel), and it shares your whole history, not one year.
export const YearTile: React.FC<YearTileProps> = ({ review, cities, onOpen }) => {
  const line = [plural(review.events, 'show', 'shows'), plural(review.artists, 'act', 'acts'), plural(cities, 'city', 'cities')];
  if (review.topArtist) line.push(`most seen: ${review.topArtist.label}`);
  return (
    <section
      aria-labelledby="year-tile-title"
      className="flex flex-wrap items-center gap-4 rounded-card border border-accent-tint-line bg-surface-1 p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-[border-color,box-shadow] duration-150 hover:border-accent hover:shadow-[0_0_0_1px_var(--la-accent-tint-line),0_0_20px_-4px_var(--la-accent-tint)] motion-reduce:transition-none"
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-control border border-accent-tint-line bg-accent-tint text-accent">
        <Archive className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="year-tile-title" className="font-display text-xl font-normal text-text">
          See your {review.year}
        </h2>
        <p className="text-sm text-text-muted">{line.join(' · ')}</p>
      </div>
      <Button variant="secondary" onClick={onOpen}>
        Open Stats to share
      </Button>
    </section>
  );
};
