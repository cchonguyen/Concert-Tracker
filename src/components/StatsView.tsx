import React, { Fragment, useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { genresApi, GenresList, LoggedEvent } from '../services/lineupApi';
import { GenreCount, genreMix, genresByArtist } from '../services/genres';
import { whenLabel } from '../services/format';
import { attendanceOf } from '../server/events/attendance';
import { allTime, AllTime, facts, pastEvents, perYear, RankBy, Ranked, seriesStats, SeriesStat, top, YearReview, yearInReview } from '../services/stats';
import { barcodeBars } from '../services/ticket';
import { EventTitle } from './EventTitle';
import { StubHeader } from './ui/StubHeader';
import { StubBarcode, StubSentence, StubSerial, Ticket, TicketKicker, TicketSmallLine } from './ui/Ticket';
import { MONTH_NAMES } from '../server/lineup/months';
import { NameList } from './ui/NameList';

// Bars grow in once per visit to Stats (design-refresh-2.md, section 4): only while the page has just opened,
// so changing the year or a filter later swaps them in place. Off with reduced motion.
let openedAt = 0;
const GROW_WINDOW_MS = 1200;
function useGrow(axis: 'x' | 'y') {
  const still = useReducedMotion();
  const fresh = Date.now() - openedAt < GROW_WINDOW_MS;
  if (still || !fresh) return { initial: false as const };
  return axis === 'y'
    ? { initial: { scaleY: 0 }, animate: { scaleY: 1 }, transition: { duration: 0.45, ease: [0.2, 0.8, 0.2, 1] as const }, style: { originY: 1 } }
    : { initial: { scaleX: 0 }, animate: { scaleX: 1 }, transition: { duration: 0.45, ease: [0.2, 0.8, 0.2, 1] as const }, style: { originX: 0 } };
}

interface StatsViewProps {
  events: LoggedEvent[];
  onOpen: (id: string) => void;
  onOpenTable: (query: string) => void;
}

const MONTHS = MONTH_NAMES;
const card = 'rounded-card border border-line bg-surface-1 p-4';
const title = 'font-display text-lg font-normal leading-tight text-text';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// All time: the totals the Table used to show, one cell each, with what each one covers (docs/specs/quiet-tips-table.md).
const AllTimeStrip: React.FC<{ t: AllTime }> = ({ t }) => {
  const cells: { k: string; v: string; c: string }[] = [
    { k: 'Shows', v: t.events.toLocaleString(), c: 'you went to' },
    { k: 'Acts', v: t.acts.toLocaleString(), c: 'seen live' },
    { k: 'Venues', v: t.venues.toLocaleString(), c: `in ${t.cities} ${t.cities === 1 ? 'city' : 'cities'}` },
  ];
  if (t.firstYear !== undefined && t.lastYear !== undefined) {
    cells.push({ k: 'Years', v: String(t.lastYear - t.firstYear + 1), c: t.firstYear === t.lastYear ? String(t.firstYear) : `${t.firstYear} to ${t.lastYear}` });
  }
  if (t.averageRating !== undefined) cells.push({ k: 'Average rating', v: String(t.averageRating), c: `from ${t.rated} rated` });
  if (t.totalPrice !== undefined) cells.push({ k: 'Spent', v: Math.round(t.totalPrice).toLocaleString(), c: `on ${t.priced} priced` });
  return (
    <section aria-label="All time" className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">All time</h2>
      <dl className="grid grid-cols-2 gap-px overflow-hidden border border-line-strong bg-line sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((cell) => (
          <div key={cell.k} className="flex flex-col gap-1 bg-surface-1 px-3.5 py-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{cell.k}</dt>
            <dd className="font-display text-2xl leading-none text-text tabular-nums">{cell.v}</dd>
            <dd className="text-xs text-text-muted">{cell.c}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

// Events per year as bars; empty years stay as gaps. A bar opens that year in the Table.
const YearChart: React.FC<{ years: ReturnType<typeof perYear>['years']; onPick: (year: number) => void }> = ({ years, onPick }) => {
  const growY = useGrow('y');
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
              <motion.span
                {...growY}
                className={`mx-auto block w-full max-w-12 rounded-t-[3px] bg-gradient-to-b transition-[filter] ${
                  now ? 'from-accent-fill to-accent-fill/70' : 'from-accent-fill/85 to-accent-fill/20'
                } ${hover === y.year ? 'brightness-125' : 'group-hover:brightness-125'}`}
                style={{ ...growY.style, height: y.events ? `${(y.events / max) * 100}%` : 0 }}
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
  const growX = useGrow('x');
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <StubHeader
      title={<h3 className="m-0 inline font-normal">{name}</h3>}
      kicker="RANKING"
      segments={rows.length > 0 ? [{ k: 'MOST', v: `${rows[0].count}×` }] : []}
    >
      <div className="px-4 py-3">
        {rows.length === 0 ? (
          <p className="text-sm text-text-muted">{empty}</p>
        ) : (
          <ol className="space-y-1.5">
            {rows.map((r, i) => (
              <li key={r.key}>
                <button onClick={() => onPick(r)} className="group block min-h-11 w-full space-y-0.5 py-1 text-left sm:min-h-9" title={`${r.label}: ${plural(r.count, 'event')}`}>
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-xs font-bold text-accent">{String(i + 1).padStart(2, '0')}</span>
                      <span className="truncate text-text group-hover:text-accent">{r.label}</span>
                    </span>
                    <span className="shrink-0 text-xs text-text-muted">{r.count}</span>
                  </span>
                  <span className="block h-1.5 w-full rounded-full bg-surface-2">
                    <motion.span {...growX} className="block h-full rounded-full bg-accent-fill group-hover:brightness-125" style={{ ...growX.style, width: `${(r.count / max) * 100}%` }} />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </StubHeader>
  );
};

// What you see live by genre: each set you saw split across its act's genres.
// Sets whose act has no genre are counted apart, not spread over the rest.
const GenreBars: React.FC<{ name: string; rows: GenreCount[]; note?: string }> = ({ name, rows, note }) => {
  const growX = useGrow('x');
  const max = Math.max(...rows.map((r) => r.share), 0.01);
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs text-text-muted">{name}</h3>
      {note && <p className="text-xs text-text-faint">{note}</p>}
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.name} className="space-y-0.5" title={`${r.name}: ${r.sets.toFixed(1)} sets`}>
            <span className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-text">{r.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-text-muted">{Math.round(r.share * 100)}%</span>
            </span>
            <span className="block h-1.5 w-full rounded-full bg-surface-2">
              <motion.span {...growX} className="block h-full rounded-full bg-accent-fill" style={{ ...growX.style, width: `${(r.share / max) * 100}%` }} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
};

type GenreData = Pick<GenresList, 'genres' | 'vocabulary' | 'map'>;

const GenreCard: React.FC<{ events: LoggedEvent[]; data: GenreData }> = ({ events, data }) => {
  const mix = useMemo(
    () => genreMix(events, genresByArtist(data.genres, data.vocabulary, data.map), data.vocabulary),
    [events, data],
  );
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
        {mix.umbrellas.length > 0 && (
          <GenreBars
            name="Including related genres"
            note="A set counts once under each umbrella it falls in."
            rows={mix.umbrellas.slice(0, 10)}
          />
        )}
      </div>
    </section>
  );
};

const NO_GENRES: GenreData = { genres: [], vocabulary: { genres: [] }, map: [] };

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

// The framing ticket for the picked year. Its numbers are the same as the list below it.
// prevEvents is the previous year's shows, given only when that year has shows; otherwise the change is left off.
const YearTicket: React.FC<{ review: YearReview; prevEvents?: number }> = ({ review, prevEvents }) => {
  const wide = useWide();
  const { year, events, artists, newArtists, rated, averageRating } = review;
  const change = prevEvents === undefined ? null : events - prevEvents;
  const changeText = change === null ? null : change > 0 ? `+${change}` : change < 0 ? `−${-change}` : 'Same';
  const sentence =
    change === null
      ? null
      : change === 0
        ? `${plural(events, 'show')} in ${year}, the same number as ${year - 1}.`
        : `${plural(events, 'show')} in ${year}, ${Math.abs(change)} ${change > 0 ? 'more' : 'fewer'} than ${year - 1}.`;

  const body = (
    <>
      <TicketKicker items={['Admit one', `Your ${year}`]} />
      <p className="font-display text-[28px] leading-none tracking-[-0.02em] text-text [text-wrap:balance] sm:text-[34px]">
        {[plural(events, 'show'), plural(artists, 'act'), plural(newArtists.length, 'first-timer')].map((part, i, all) => (
          <Fragment key={part}>
            <span className="whitespace-nowrap">{i < all.length - 1 ? `${part} ·` : part}</span>
            {i < all.length - 1 ? ' ' : ''}
          </Fragment>
        ))}
      </p>
      {rated > 0 && averageRating !== undefined && <TicketSmallLine>{`Average rating ${averageRating} (${rated} rated)`}</TicketSmallLine>}
    </>
  );

  const stub = (
    <div className="flex h-full flex-col justify-between gap-3">
      {changeText !== null && (
        <div aria-hidden="true" className="flex flex-col gap-px">
          <span className="font-mono text-[9.5px] tracking-[0.16em] text-text-faint">{`vs ${year - 1}`}</span>
          <span className="flex items-baseline gap-1.5">
            <span className="font-sans text-xl font-bold text-text">{changeText}</span>
            <span className="font-mono text-[10px] text-text-muted">shows</span>
          </span>
        </div>
      )}
      <StubSerial text={`No. ${events}`} />
      <StubBarcode bars={barcodeBars(`stats-year-${year}`)} height={34} />
      {sentence && <StubSentence text={sentence} />}
    </div>
  );

  return (
    <Ticket
      layout={wide ? 'columns' : 'rows'}
      size="hero"
      stubWidth={150}
      label={`Your ${year} in numbers`}
      body={body}
      stub={stub}
    />
  );
};

// Your series: editions, years in a row, cities, and acts you keep seeing
// there. A row opens that series in the Table.
const SeriesCard: React.FC<{ rows: SeriesStat[]; onPick: (name: string) => void }> = ({ rows, onPick }) => {
  const growX = useGrow('x');
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
                <motion.span {...growX} className="block h-1.5 rounded-full bg-accent-fill group-hover:brightness-125" style={{ ...growX.style, width: `${(r.editions / max) * 100}%` }} />
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
  // Marks the start of this visit before the bars first render, so they grow in once.
  useState(() => {
    openedAt = Date.now();
  });
  const today = new Date().toISOString().slice(0, 10);
  const past = useMemo(() => pastEvents(events, today), [events, today]);
  // Optional: without genres (or before 0013 is applied) the card is left out.
  const [genreData, setGenreData] = useState<GenreData>(NO_GENRES);
  useEffect(() => {
    genresApi
      .list()
      .then((r) => setGenreData({ genres: r.genres, vocabulary: r.vocabulary, map: r.map }))
      .catch(() => setGenreData(NO_GENRES));
  }, []);
  const { years, undated } = useMemo(() => perYear(past), [past]);
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  const reviewYears = years.filter((y) => y.events > 0).map((y) => y.year).reverse();
  const year = pickedYear ?? reviewYears[0];
  const review = useMemo(() => (year ? yearInReview(past, year) : null), [past, year]);
  const prevEvents = useMemo(
    () => (year && years.some((y) => y.year === year - 1 && y.events > 0) ? yearInReview(past, year - 1).events : undefined),
    [past, years, year],
  );
  const f = useMemo(() => facts(past), [past]);
  const totals = useMemo(() => allTime(events, today), [events, today]);
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
      <AllTimeStrip t={totals} />
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
          <YearTicket review={review} prevEvents={prevEvents} />
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
                <NameList names={review.newArtists.slice(0, 12)} />
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

      <GenreCard events={past} data={genreData} />

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
