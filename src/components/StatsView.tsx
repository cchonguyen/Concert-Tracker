import React, { useEffect, useMemo, useState } from 'react';
import { genresApi, LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, GenreCount, genreMix, genresByArtist } from '../services/genres';
import { whenLabel } from '../services/format';
import { attendanceOf } from '../server/events/attendance';
import { facts, pastEvents, perYear, RankBy, Ranked, seriesStats, SeriesStat, top, yearInReview } from '../services/stats';
import { EventTitle } from './EventTitle';
import { MONTH_NAMES } from '../server/lineup/months';

interface StatsViewProps {
  events: LoggedEvent[];
  onOpen: (id: string) => void;
  onOpenTable: (query: string) => void;
}

const MONTHS = MONTH_NAMES;
const card = 'rounded-card border border-line bg-surface-1 p-4';
const title = 'font-display text-lg font-normal leading-tight text-text';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Events per year as bars; empty years stay as gaps. A bar opens that year in the Table.
const YearChart: React.FC<{ years: ReturnType<typeof perYear>['years']; onPick: (year: number) => void }> = ({ years, onPick }) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...years.map((y) => y.events));
  const showLabel = (i: number) => years.length <= 12 || i === 0 || i === years.length - 1 || years[i].year % 5 === 0;
  const h = years.find((y) => y.year === hover);
  const thisYear = new Date().getFullYear();
  return (
    <div className="space-y-2">
      <div className="flex h-5 items-baseline justify-between text-xs">
        <span className="text-text-muted">
          {h ? (
            <>
              <span className="font-semibold text-text">{h.year}</span>: {plural(h.events, 'event')}
              {h.newArtists > 0 && `, ${plural(h.newArtists, 'new artist')}`}
            </>
          ) : (
            <span className="text-text-muted">Most in a year: {max}</span>
          )}
        </span>
      </div>
      <div className="relative flex h-40 items-end gap-[2px] border-b border-line-strong" onMouseLeave={() => setHover(null)}>
        {/* Dashed guides at half and the full maximum, labelled in mono. */}
        {[1, 0.5].map((f) => (
          <div key={f} aria-hidden="true" className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `${f * 100}%` }}>
            <span className="absolute -top-2 right-0 bg-surface-1 pl-1 font-mono text-[10px] tabular-nums text-text-faint">{Math.round(max * f)}</span>
          </div>
        ))}
        {years.map((y) => {
          const now = y.year === thisYear;
          return (
            <button
              key={y.year}
              onClick={() => onPick(y.year)}
              onMouseEnter={() => setHover(y.year)}
              onFocus={() => setHover(y.year)}
              aria-label={`${y.year}: ${plural(y.events, 'event')}`}
              className="group relative flex h-full min-w-0 flex-1 items-end"
            >
              {now && y.events > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-control border border-accent-tint-line bg-accent-tint px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text"
                  style={{ bottom: `${(y.events / max) * 100}%` }}
                >
                  {y.events} this year
                </span>
              )}
              <span
                className={`mx-auto block w-full max-w-12 rounded-t-[3px] bg-gradient-to-b transition-[filter] ${
                  now ? 'from-accent-fill to-accent-fill/70' : 'from-accent-fill/85 to-accent-fill/20'
                } ${hover === y.year ? 'brightness-125' : 'group-hover:brightness-125'}`}
                style={{ height: y.events ? `${(y.events / max) * 100}%` : 0 }}
              />
            </button>
          );
        })}
      </div>
      <div className="flex gap-[2px] font-mono text-[10px] tabular-nums text-text-muted">
        {years.map((y, i) => (
          <span key={y.year} className="min-w-0 flex-1 text-center">
            {showLabel(i) ? (years.length > 12 ? `'${String(y.year).slice(2)}` : y.year) : ''}
          </span>
        ))}
      </div>
    </div>
  );
};

const Ranking: React.FC<{ name: string; rows: Ranked[]; empty: string; onPick: (r: Ranked) => void }> = ({ name, rows, empty, onPick }) => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className={`${card} space-y-2`}>
      <h3 className={title}>{name}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.key}>
              <button onClick={() => onPick(r)} className="group block min-h-11 w-full space-y-0.5 py-1 text-left sm:min-h-9" title={`${r.label}: ${plural(r.count, 'event')}`}>
                <span className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate text-text group-hover:text-accent">{r.label}</span>
                  <span className="shrink-0 text-xs text-text-muted">{r.count}</span>
                </span>
                <span className="block h-1.5 w-full rounded-full bg-surface-2">
                  <span className="block h-full rounded-full bg-accent-fill group-hover:brightness-125" style={{ width: `${(r.count / max) * 100}%` }} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

// What you see live by genre: each set you saw split across its act's genres.
// Sets whose act has no genre are counted apart, not spread over the rest.
const GenreBars: React.FC<{ name: string; rows: GenreCount[] }> = ({ name, rows }) => {
  const max = Math.max(...rows.map((r) => r.share), 0.01);
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs text-text-muted">{name}</h3>
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.name} className="space-y-0.5" title={`${r.name}: ${r.sets.toFixed(1)} sets`}>
            <span className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-text">{r.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-text-muted">{Math.round(r.share * 100)}%</span>
            </span>
            <span className="block h-1.5 w-full rounded-full bg-surface-2">
              <span className="block h-full rounded-full bg-accent-fill" style={{ width: `${(r.share / max) * 100}%` }} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
};

const GenreCard: React.FC<{ events: LoggedEvent[]; rows: ArtistGenres[] }> = ({ events, rows }) => {
  const mix = useMemo(() => genreMix(events, genresByArtist(rows)), [events, rows]);
  if (!mix.known) return null;
  return (
    <section className={`${card} space-y-3`}>
      <div>
        <h2 className={title}>Genres you see live</h2>
        <p className="text-xs text-text-muted">
          Share of the sets you saw, from {mix.known} of {plural(mix.sets, 'set')}
          {mix.sets > mix.known && `; ${mix.sets - mix.known === 1 ? 'the other one has' : `the other ${mix.sets - mix.known} have`} no genre yet (Table, Genres)`}.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <GenreBars name="Genre" rows={mix.parents.slice(0, 8)} />
        <GenreBars name="Style" rows={mix.styles.slice(0, 10)} />
      </div>
    </section>
  );
};

const Tile: React.FC<{ value: React.ReactNode; label: string }> = ({ value, label }) => (
  <div>
    <div className="text-xl font-extrabold tracking-tight text-text">{value}</div>
    <div className="text-xs text-text-muted">{label}</div>
  </div>
);

// Your series: editions, years in a row, cities, and acts you keep seeing
// there. A row opens that series in the Table.
const SeriesCard: React.FC<{ rows: SeriesStat[]; onPick: (name: string) => void }> = ({ rows, onPick }) => {
  const max = Math.max(1, ...rows.map((r) => r.editions));
  const best = rows.reduce<SeriesStat | undefined>((a, r) => (r.streak && (!a?.streak || r.streak.years > a.streak.years) ? r : a), undefined);
  return (
    <section className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={title}>Series</h2>
        {best?.streak && (
          <span className="text-xs text-text-muted">
            Longest run: <span className="text-text">{best.name}</span>, {best.streak.years} years in a row ({best.streak.from} to {best.streak.to})
          </span>
        )}
      </div>
      <ol className="space-y-3">
        {rows.slice(0, 8).map((r) => (
          <li key={r.name}>
            <button onClick={() => onPick(r.name)} className="group block min-h-11 w-full space-y-1 py-1 text-left sm:min-h-9">
              <span className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium text-text group-hover:text-accent">{r.name}</span>
                <span className="shrink-0 tabular-nums text-text-muted">{plural(r.editions, 'edition')}</span>
              </span>
              <span className="block h-1.5 rounded-full bg-surface-3">
                <span className="block h-1.5 rounded-full bg-accent-fill group-hover:brightness-125" style={{ width: `${(r.editions / max) * 100}%` }} />
              </span>
              <span className="block text-xs text-text-muted">
                {[
                  r.years.length ? (r.years.length === 1 ? String(r.years[0]) : `${r.years[0]} to ${r.years[r.years.length - 1]}`) : null,
                  r.streak ? `${r.streak.years} years in a row` : null,
                  r.cities.length > 1 ? `${r.cities.length} cities` : r.cities[0] ?? null,
                  r.acts ? plural(r.acts, 'act') + ' seen' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {r.regulars.length > 0 && (
                <span className="block text-xs text-text-muted">
                  <span className="text-text-muted">Regulars: </span>
                  {r.regulars.map((a) => `${a.label} ×${a.count}`).join(', ')}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
};

export const StatsView: React.FC<StatsViewProps> = ({ events, onOpen, onOpenTable }) => {
  const today = new Date().toISOString().slice(0, 10);
  const past = useMemo(() => pastEvents(events, today), [events, today]);
  // Optional: without genres (or before 0013 is applied) the card is left out.
  const [genreRows, setGenreRows] = useState<ArtistGenres[]>([]);
  useEffect(() => {
    genresApi
      .list()
      .then((r) => setGenreRows(r.genres))
      .catch(() => setGenreRows([]));
  }, []);
  const { years, undated } = useMemo(() => perYear(past), [past]);
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  const reviewYears = years.filter((y) => y.events > 0).map((y) => y.year).reverse();
  const year = pickedYear ?? reviewYears[0];
  const review = useMemo(() => (year ? yearInReview(past, year) : null), [past, year]);
  const f = useMemo(() => facts(past), [past]);
  const ranks = useMemo(
    () => Object.fromEntries((['artist', 'venue', 'city', 'companion'] as RankBy[]).map((by) => [by, top(past, by, 8)])) as Record<RankBy, Ranked[]>,
    [past],
  );
  const filter = (param: string, value: string) => onOpenTable(`${param}=${encodeURIComponent(value)}`);
  const series = useMemo(() => seriesStats(past), [past]);

  // What is held back, so the counts below never look like they lost events.
  const held = useMemo(() => {
    const n = { upcoming: 0, confirm: 0 };
    for (const e of events) {
      const a = attendanceOf(e, today);
      if (a === 'upcoming' || a === 'confirm') n[a] += 1;
    }
    return n;
  }, [events, today]);
  const heldNote = (held.upcoming > 0 || held.confirm > 0) && (
    <p className="text-xs text-text-muted">
      Not counted yet:{' '}
      {held.upcoming > 0 && (
        <button onClick={() => onOpenTable('went=upcoming')} className="hover:text-text-muted hover:underline">
          {held.upcoming} upcoming
        </button>
      )}
      {held.upcoming > 0 && held.confirm > 0 && ', '}
      {held.confirm > 0 && (
        <button onClick={() => onOpenTable('went=confirm')} className="text-accent hover:underline">
          {held.confirm} waiting for you to say you went
        </button>
      )}
      .
    </p>
  );

  if (!past.length) {
    return (
      <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-text-muted">
        Stats appear once you have logged an event you went to.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {heldNote}
      {years.length > 0 && (
        <section className={`${card} space-y-2`}>
          <h2 className={title}>Events per year</h2>
          <YearChart years={years} onPick={(y) => onOpenTable(`from=${y}&to=${y}`)} />
          {undated > 0 && (
            <button onClick={() => onOpenTable('needs=date')} className="text-xs text-text-muted hover:text-text-muted">
              {plural(undated, 'event')} without a year not shown
            </button>
          )}
        </section>
      )}

      {review && (
        <section className={`${card} space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={title}>Year in review</h2>
            <div className="flex flex-wrap gap-1">
              {reviewYears.slice(0, 8).map((y) => (
                <button
                  key={y}
                  onClick={() => setPickedYear(y)}
                  aria-pressed={y === year}
                  className={`min-h-11 rounded-control border px-2 font-mono text-xs tabular-nums sm:min-h-9 ${y === year ? 'border-accent-tint-line bg-accent-tint font-semibold text-text' : 'border-transparent text-text-muted hover:text-text'}`}
                >
                  {y}
                </button>
              ))}
              {reviewYears.length > 8 && (
                <select
                  value={reviewYears.slice(0, 8).includes(year) ? '' : year}
                  onChange={(e) => e.target.value && setPickedYear(Number(e.target.value))}
                  className="rounded-md border border-line bg-surface-2 px-1 text-xs text-text-muted"
                >
                  <option value="">Earlier</option>
                  {reviewYears.slice(8).map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Tile value={review.events} label="Events" />
            <Tile value={review.artists} label="Artists seen" />
            <Tile value={review.newArtists.length} label="First-time artists" />
            <Tile
              value={review.averageRating ?? <span className="text-text-muted">–</span>}
              label={review.rated ? `Average rating (${review.rated} rated)` : 'No ratings yet'}
            />
          </div>
          <ul className="space-y-1 text-sm text-text-muted">
            {review.topArtist && (
              <li>
                <span className="text-text-muted">Most seen: </span>
                {review.topArtist.label}, {review.topArtist.count} times
              </li>
            )}
            {review.topVenue && (
              <li>
                <span className="text-text-muted">Top venue: </span>
                {review.topVenue.label}, {plural(review.topVenue.count, 'visit')}
              </li>
            )}
            {review.topCompanion && (
              <li>
                <span className="text-text-muted">Went most with: </span>
                {review.topCompanion.label}, {plural(review.topCompanion.count, 'event')}
              </li>
            )}
            {review.busiestMonth && (
              <li>
                <span className="text-text-muted">Busiest month: </span>
                {MONTHS[review.busiestMonth.month - 1]}, {plural(review.busiestMonth.events, 'event')}
              </li>
            )}
            {review.newArtists.length > 0 && (
              <li className="text-text-muted">
                <span className="text-text-muted">First time seeing: </span>
                {review.newArtists.slice(0, 12).join(', ')}
                {review.newArtists.length > 12 && ` and ${review.newArtists.length - 12} more`}
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-2">
        <Ranking name="Top artists" rows={ranks.artist} empty="Mark who you saw on an event to rank artists." onPick={(r) => filter('artist', r.key)} />
        <Ranking name="Top venues" rows={ranks.venue} empty="No venues yet." onPick={(r) => filter('venue', r.key)} />
        <Ranking name="Top cities" rows={ranks.city} empty="No cities yet." onPick={(r) => filter('city', r.key)} />
        <Ranking name="Went with most" rows={ranks.companion} empty="Add who you went with on an event to see this." onPick={(r) => filter('with', r.key)} />
      </section>

      <GenreCard events={past} rows={genreRows} />

      {series.length > 0 && <SeriesCard rows={series} onPick={(name) => filter('series', name)} />}

      <section className={`${card} space-y-2`}>
        <h2 className={title}>Fun facts</h2>
        <ul className="space-y-1.5 text-sm text-text-muted">
          {f.first && (
            <li>
              <span className="text-text-muted">First event logged: </span>
              <button onClick={() => onOpen(f.first!.id)} className="hover:text-accent hover:underline">
                <EventTitle event={f.first} />, {whenLabel(f.first)}
              </button>
            </li>
          )}
          {f.mostSeen && (
            <li>
              <span className="text-text-muted">Seen most: </span>
              {f.mostSeen.label}, {f.mostSeen.count} times
            </li>
          )}
          {f.busiestStretch && (
            <li>
              <span className="text-text-muted">Busiest stretch: </span>
              {f.busiestStretch.events} events within 30 days ({whenLabel({ startDate: f.busiestStretch.from })} to{' '}
              {whenLabel({ startDate: f.busiestStretch.to })})
            </li>
          )}
          {f.longestGap && (
            <li>
              <span className="text-text-muted">Longest break: </span>
              {plural(f.longestGap.days, 'day')}, between <EventTitle event={f.longestGap.from} /> and <EventTitle event={f.longestGap.to} />
            </li>
          )}
          {f.actsPerEvent && (
            <li>
              <span className="text-text-muted">Acts per event: </span>
              {f.actsPerEvent.average} on average ({plural(f.actsPerEvent.events, 'event')} with acts marked)
            </li>
          )}
        </ul>
      </section>
    </div>
  );
};
