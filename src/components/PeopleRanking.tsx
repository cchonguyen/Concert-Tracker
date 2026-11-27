import React, { useMemo } from 'react';
import type { LoggedEvent } from '../services/lineupApi';
import type { ArtistGenres } from '../services/genres';
import { peopleGenres } from '../services/genreInsights';
import type { GenreVocabulary } from '../server/events/genreTypes';

interface PeopleRankingProps {
  events: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  onOpenTable: (query: string) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const PeopleRanking: React.FC<PeopleRankingProps> = ({
  events,
  byArtist,
  vocabulary,
  onOpenTable,
}) => {
  const locked = events.some((e) => e.peopleLocked);
  const today = new Date().toISOString().slice(0, 10);

  const peopleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.personIds?.length) {
        e.personIds.forEach((pid, i) => {
          const name = e.companions[i];
          if (pid && name && !map.has(pid)) map.set(pid, name);
        });
      } else {
        for (const c of e.companions) {
          if (c && !map.has(c)) map.set(c, c);
        }
      }
    }
    return map;
  }, [events]);

  const res = useMemo(
    () => (locked ? { people: [], headline: null } : peopleGenres(events, byArtist, vocabulary, peopleMap, today)),
    [locked, events, byArtist, vocabulary, peopleMap, today],
  );

  if (locked) {
    return (
      <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-text-muted">
        Unlock your vault to see this
      </p>
    );
  }

  if (res.people.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-text-muted">
        Add who you went with on an event to see this.
      </p>
    );
  }

  return (
    <section className="space-y-4 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="poster-head text-2xl text-text">People &amp; genres</h2>
        {res.headline && <p className="text-sm font-medium text-text">{res.headline}</p>}
      </div>

      <ol className="divide-y divide-line">
        {res.people.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onOpenTable(`with=${encodeURIComponent(p.name)}`)}
              className="group flex min-h-11 w-full flex-wrap items-baseline justify-between gap-2 py-2.5 text-left hover:text-accent sm:min-h-9"
            >
              <span className="min-w-0">
                <span className="font-medium text-text group-hover:text-accent">{p.name}</span>
                {p.topGroups.length > 0 && (
                  <span className="block text-xs text-text-muted">
                    {p.topGroups.map((g) => `${g.group} ${g.count} of ${g.totalWithAnyone}`).join(' · ')}
                  </span>
                )}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                {plural(p.shows, 'show')} together
              </span>
            </button>
          </li>
        ))}
      </ol>

      <p className="text-[11px] text-text-faint">
        Counts each show once per macro genre when any act you saw there has it.
      </p>
    </section>
  );
};
