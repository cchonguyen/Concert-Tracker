import React, { useMemo } from 'react';
import type { LoggedEvent } from '../services/lineupApi';
import type { ArtistGenres } from '../services/genres';
import {
  FIRSTS_MIN_SETS,
  genreFirsts,
  genreLabel,
  genreMilestones,
  genreRange,
  newThisYear,
} from '../services/genreInsights';
import type { GenreVocabulary } from '../server/events/genreTypes';
import { Pill } from './ui/Pill';
import { Popover } from './ui/Popover';

interface GenreStoryProps {
  events: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  mapGroups: string[];
  today: string;
  onOpenEvent?: (id: string) => void;
}

function formatDate(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  if (/^\d{4}-\d{2}$/.test(d)) {
    return new Date(`${d}-01T12:00:00Z`).toLocaleDateString(undefined, {
      timeZone: 'UTC',
      month: 'short',
      year: 'numeric',
    });
  }
  return d;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export const GenreStory: React.FC<GenreStoryProps> = ({
  events,
  byArtist,
  vocabulary,
  mapGroups,
  today,
  onOpenEvent,
}) => {
  const firsts = useMemo(() => genreFirsts(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);
  const newStyles = useMemo(() => newThisYear(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);
  const milestones = useMemo(
    () => genreMilestones(events, byArtist, vocabulary, today),
    [events, byArtist, vocabulary, today],
  );
  const range = useMemo(
    () => genreRange(events, byArtist, vocabulary, today, mapGroups),
    [events, byArtist, vocabulary, today, mapGroups],
  );
  const label = useMemo(() => genreLabel(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);

  if (firsts.knownSets < FIRSTS_MIN_SETS) return null;

  const year = today.slice(0, 4);

  return (
    <section className="space-y-4">
      <h2 className="font-display text-xl font-normal text-text">Your genre story</h2>

      <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
        <div>
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">
            How each genre found you
          </h3>
          <p className="text-xs text-text-muted">
            Counts any set where the act has the genre. Dates are the first you logged.
          </p>
        </div>

        <ol className="space-y-1.5">
          {firsts.items.map((item) => {
            const actsLine =
              item.moreCount > 0 ? `${item.acts.join(', ')} and ${item.moreCount} more` : item.acts.join(' & ');
            const text = `${actsLine} at ${item.eventName}, ${formatDate(item.date)}`;
            return (
              <li key={item.group} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                <span className="w-11 shrink-0 font-mono text-xs tabular-nums text-text-muted">{item.year}</span>
                <span className="w-28 shrink-0 truncate font-medium text-text">{item.group}</span>
                {onOpenEvent ? (
                  <button
                    type="button"
                    onClick={() => onOpenEvent(item.eventId)}
                    className="min-h-11 text-left text-xs text-text-muted hover:text-accent sm:min-h-9"
                  >
                    {text}
                  </button>
                ) : (
                  <span className="text-xs text-text-muted">{text}</span>
                )}
              </li>
            );
          })}
        </ol>

        {newStyles.length > 0 && (
          <div className="space-y-2 border-t border-line pt-3">
            <h4 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              New to you in {year}
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {newStyles.map((s) => (
                <Pill key={s.key} tone="neutral">
                  {s.name}
                </Pill>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Milestones</h3>
            <p className="text-xs text-text-muted">Counts any set where the act has the genre.</p>
          </div>

          {milestones.reached.length > 0 && (
            <ul className="space-y-2">
              {milestones.reached.map((m) => {
                const detail = `${m.actName} at ${m.eventName}${m.date ? `, ${formatDate(m.date)}` : ''}`;
                return (
                  <li key={`${m.group}-${m.mark}`} className="rounded-control border border-line bg-surface-2 px-3 py-2 text-xs">
                    <p className="font-semibold text-text">
                      {ordinal(m.mark)} {m.group.toLowerCase()} set
                    </p>
                    {onOpenEvent ? (
                      <button
                        type="button"
                        onClick={() => onOpenEvent(m.eventId)}
                        className="mt-0.5 inline-flex min-h-11 items-center text-left text-text-muted hover:text-accent sm:min-h-9"
                      >
                        {detail}
                      </button>
                    ) : (
                      <p className="mt-0.5 text-text-muted">{detail}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {milestones.anniversaries.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {milestones.anniversaries.map((a) => (
                <Pill key={a.group} tone="highlight">
                  {a.years} years of {a.group.toLowerCase()}
                </Pill>
              ))}
            </div>
          )}

          {milestones.nextUp && (
            <p className="text-xs text-text-muted">
              Next up: your {ordinal(milestones.nextUp.mark)} {milestones.nextUp.group.toLowerCase()} set is{' '}
              {milestones.nextUp.remaining} {milestones.nextUp.remaining === 1 ? 'set' : 'sets'} away
            </p>
          )}

          {milestones.reached.length === 0 && milestones.anniversaries.length === 0 && !milestones.nextUp && (
            <p className="text-xs text-text-muted">Your first genre milestone arrives at 10 sets.</p>
          )}
        </div>

        <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Your range</h3>
            {label && (
              <Popover label={label.label} align="end" content={<span className="text-xs">{label.rule}</span>}>
                <Pill tone="highlight">{label.label}</Pill>
              </Popover>
            )}
          </div>

          <p className="text-sm font-medium text-text">
            {range.styleCount} {range.styleCount === 1 ? 'genre' : 'genres'} across {range.seenGroupCount} of{' '}
            {range.totalGroupCount} groups
          </p>

          {range.squares.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {range.squares.map((s) => (
                <span
                  key={s.group}
                  title={s.group}
                  aria-label={`${s.group}: ${s.seen ? 'seen' : 'not yet'}`}
                  className={`h-4 w-4 rounded-sm ${s.seen ? 'bg-accent-fill' : 'border border-line bg-surface-3'}`}
                />
              ))}
            </div>
          )}

          {range.topGroup && (
            <p className="text-xs text-text-muted">
              Your top genre, {range.topGroup.name.toLowerCase()}, is {Math.round(range.topGroup.share * 100)}% of your
              sets.
            </p>
          )}

          {range.missingGroups.length >= 1 && range.missingGroups.length <= 4 && (
            <p className="text-xs text-text-muted">
              Not yet: {range.missingGroups.map((g) => g.toLowerCase()).join(', ')}.
            </p>
          )}

          <p className="text-[11px] text-text-faint">Shares split each set across its act&apos;s genres by weight.</p>
        </div>
      </div>
    </section>
  );
};
