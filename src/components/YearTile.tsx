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
    <section aria-labelledby="year-tile-title" className="flex flex-wrap items-center gap-4 rounded-2xl border border-violet-500/30 bg-violet-500/5 p-4">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-600/20 text-violet-300">
        <Archive className="h-6 w-6" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="year-tile-title" className="text-base font-bold text-zinc-100">
          See your {review.year}
        </h2>
        <p className="text-sm text-zinc-400">{line.join(' · ')}</p>
      </div>
      <Button variant="secondary" onClick={onOpen}>
        Open Stats to share
      </Button>
    </section>
  );
};
