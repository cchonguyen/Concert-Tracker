import React, { useMemo } from 'react';
import type { LoggedEvent } from '../services/lineupApi';
import type { ArtistGenres } from '../services/genres';
import {
  FIRSTS_MIN_SETS,
  genreByKind,
  genreBySeason,
  genreByYear,
  genreFirsts,
  genreLabel,
  genreMilestones,
  genreRange,
  genreStoryLine,
  newThisYear,
} from '../services/genreInsights';
import type { GenreVocabulary } from '../server/events/genreTypes';
import { GenreYearsChart } from './GenreYearsChart';
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
  const byYear = useMemo(() => genreByYear(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);
  const storyLine = useMemo(() => genreStoryLine(byYear), [byYear]);
  const byKind = useMemo(() => genreByKind(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);
  const bySeason = useMemo(() => genreBySeason(events, byArtist, vocabulary, today), [events, byArtist, vocabulary, today]);

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

      <GenreYearsChart data={byYear} storyLine={storyLine} />

      {byKind.bars.length > 0 && (
        <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">
              By kind of night
            </h3>
            {byKind.headline && <p className="mt-1 text-sm font-medium text-text">{byKind.headline}</p>}
          </div>
          <ul className="space-y-2.5">
            {byKind.bars.map((bar) => {
              const palette = ['var(--accent, #e11d48)', '#38bdf8', '#34d399', '#f59e0b', '#94a3b8'];
              const top4 = bar.segments.slice(0, 4);
              const otherShare = bar.segments.slice(4).reduce((sum, s) => sum + s.share, 0);
              const segs = otherShare > 0 ? [...top4, { group: 'Other', sets: 0, share: otherShare }] : top4;
              return (
                <li key={bar.label} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-text">
                      {bar.label} <span className="font-normal text-text-muted">({bar.knownSets} sets)</span>
                    </span>
                    <span className="font-mono tabular-nums text-text-muted">
                      {bar.topGroup} {Math.round((bar.segments[0]?.share ?? 0) * 100)}%
                    </span>
                  </div>
                  <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3">
                    {segs.map((seg, i) => (
                      <div
                        key={seg.group}
                        title={`${seg.group}: ${Math.round(seg.share * 100)}%`}
                        style={{
                          width: `${seg.share * 100}%`,
                          backgroundColor: palette[i % palette.length],
                        }}
                      />
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {bySeason.tiles.some((t) => t.knownSets > 0) && (
        <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">By season</h3>
            {bySeason.headline && <p className="mt-1 text-sm font-medium text-text">{bySeason.headline}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {bySeason.tiles.map((tile) => (
              <div key={tile.label} className="space-y-1 rounded-control border border-line bg-surface-2 p-3">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {tile.label}
                </p>
                {tile.enough && tile.topGroup ? (
                  <>
                    <p className="truncate text-sm font-semibold text-text">{tile.topGroup.name}</p>
                    <p className="font-mono text-xs tabular-nums text-text-muted">
                      {Math.round(tile.topGroup.share * 100)}% of {tile.knownSets} sets
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-medium text-text-muted">Not enough yet</p>
                    <p className="font-mono text-[11px] tabular-nums text-text-faint">
                      {tile.knownSets} {tile.knownSets === 1 ? 'set' : 'sets'} so far
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
