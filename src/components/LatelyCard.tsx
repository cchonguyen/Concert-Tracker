import React, { useMemo } from 'react';
import type { LoggedEvent } from '../services/lineupApi';
import type { ArtistGenres } from '../services/genres';
import {
  allGoneQuiet,
  comingUp,
  cooling,
  rising,
  RISING_MIN_SETS,
} from '../services/genreInsights';
import type { GenreVocabulary } from '../server/events/genreTypes';
import { isModifiedClick } from '../services/manageNav';

interface LatelyCardProps {
  events: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  today: string;
  onOpenEvent?: (id: string) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formatMonthYear(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' });
  }
  if (/^\d{4}-\d{2}$/.test(d)) {
    return new Date(`${d}-01T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' });
  }
  return d;
}

export const LatelyCard: React.FC<LatelyCardProps> = ({
  events,
  byArtist,
  vocabulary,
  today,
  onOpenEvent,
}) => {
  const risingRes = useMemo(() => rising(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);
  const coolingItems = useMemo(() => cooling(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);
  const allQuiet = useMemo(() => allGoneQuiet(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);
  const quiet = allQuiet[0] ?? null;
  const quietSince = useMemo(
    () => new Map(allQuiet.filter((q) => q.lastDate).map((q) => [q.key, q.lastDate!])),
    [allQuiet],
  );
  const upcoming = useMemo(
    () => comingUp(events, byArtist, vocabulary, today, quietSince),
    [events, byArtist, vocabulary, today, quietSince],
  );

  if (byArtist.size === 0) return null;

  const hasRight = Boolean(quiet) || upcoming.length > 0;
  const top = risingRes.items[0];
  const maxBar = Math.max(1, ...risingRes.items.flatMap((i) => [i.beforeSets, i.recentSets]));

  return (
    <section className="space-y-4 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
      <div className={`grid gap-6 ${hasRight ? 'sm:grid-cols-2' : ''}`}>
        <div className="space-y-3">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Lately</h2>

          {risingRes.recentKnownSets < RISING_MIN_SETS ? (
            <p className="text-sm text-text-muted">
              Not enough shows in the last 12 months to call a trend yet. You&apos;ve logged{' '}
              {plural(risingRes.recentKnownSets, 'set')} since {formatMonthYear(risingRes.windowStart)}.
            </p>
          ) : risingRes.items.length === 0 ? (
            <p className="text-sm text-text-muted">No genre has really taken off in the last 12 months.</p>
          ) : (
            <div className="space-y-3">
              {top && (
                <div className="space-y-1">
                  <p className="font-display text-lg font-normal text-text">
                    Lately you&apos;re into {top.name.toLowerCase()}.
                  </p>
                  <p className="text-xs text-text-muted">
                    {plural(Math.round(top.recentSets), 'set')} across {plural(top.recentEvents, 'event')} in the last
                    12 months, up from {Math.round(top.beforeSets)} the 12 months before.
                    {top.topArtists.length > 0 &&
                      ` ${top.topArtists.map((a) => a.name).join(' and ')} did most of it.`}
                  </p>
                </div>
              )}

              <ol className="space-y-2.5">
                {risingRes.items.map((item) => (
                  <li key={item.key} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-medium text-text">{item.name}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                        {Math.round(item.beforeSets)} → {Math.round(item.recentSets)}
                      </span>
                    </div>
                    <div className="space-y-1">
                      <div className="h-1.5 rounded-full bg-surface-3">
                        <div
                          className="h-1.5 rounded-full bg-line-strong"
                          style={{ width: `${Math.min(100, (item.beforeSets / maxBar) * 100)}%` }}
                        />
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-3">
                        <div
                          className="h-1.5 rounded-full bg-accent-fill"
                          style={{ width: `${Math.min(100, (item.recentSets / maxBar) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {coolingItems.length > 0 && (
            <div className="space-y-1.5 border-t border-line pt-3">
              <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Cooling off
              </h3>
              <ul className="space-y-1 text-xs">
                {coolingItems.map((c) => (
                  <li key={c.key} className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-text">{c.name}</span>
                    <span className="shrink-0 font-mono tabular-nums text-text-muted">
                      {Math.round(c.beforeSets)} → {plural(Math.round(c.recentSets), 'set')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] text-text-faint">
            A genre shows here only with at least 5 sets across 3 events in the last 12 months.
          </p>
        </div>

        {hasRight && (
          <div className="space-y-4 sm:border-l sm:border-line sm:pl-6">
            {quiet && (
              <div className="space-y-1.5">
                <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Gone quiet</h3>
                <p className="text-sm font-medium text-text">
                  You haven&apos;t seen a {quiet.name.toLowerCase()} set since{' '}
                  {formatMonthYear(quiet.lastDate ?? quiet.lastSortDate)}.
                </p>
                <p className="text-xs text-text-muted">
                  Your last one was {quiet.lastAct} at {quiet.lastEvent}. You&apos;d seen {quiet.sets} before that.
                </p>
                <a
                  href="?view=ranking&by=genres"
                  onClick={(e) => {
                    if (isModifiedClick(e)) return;
                    e.preventDefault();
                    window.history.pushState(null, '', '?view=ranking&by=genres');
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }}
                  className="inline-flex min-h-11 items-center text-xs font-medium text-accent hover:underline sm:min-h-9"
                >
                  See {quiet.name.toLowerCase()} in Ranking
                </a>
              </div>
            )}

            {upcoming.length > 0 && (
              <div className={`space-y-2 ${quiet ? 'border-t border-line pt-3' : ''}`}>
                <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Coming up</h3>
                <ul className="space-y-2">
                  {upcoming.map((item) => {
                    const place = item.venue || item.eventName;
                    const detail = `${item.actName} at ${place}${
                      item.firstSince ? `, the first since ${formatMonthYear(item.firstSince)}` : ''
                    }`;
                    return (
                      <li key={`${item.key}-${item.eventId}`} className="text-xs">
                        <p className="font-medium text-text">Your next {item.name.toLowerCase()} set</p>
                        {onOpenEvent ? (
                          <button
                            type="button"
                            onClick={() => onOpenEvent(item.eventId)}
                            className="inline-flex min-h-11 items-center text-left text-text-muted hover:text-accent sm:min-h-9"
                          >
                            {detail}
                          </button>
                        ) : (
                          <p className="text-text-muted">{detail}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] text-text-faint">
                  From events you planned. They never count in your totals until you went.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
