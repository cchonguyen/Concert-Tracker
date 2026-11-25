import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, Crown, FolderCog, Heart, LayoutList, List, MapPin, Search, Table2, Tags } from 'lucide-react';
import { genresApi, LoggedEvent } from '../services/lineupApi';
import { ArtistGenres, genresByArtist, topStyles } from '../services/genres';
import { artistGaps, spanLabel } from '../services/insights';
import { whenLabel } from '../services/format';
import { EventTitle } from './EventTitle';
import { Tooltip } from './ui/Tooltip';
import { ARTIST_SORTS, artistSummaries, ArtistSort, ArtistSummary, groupArtists, jumpTargets } from '../services/artists';
import { buildManageUrl, entityUrl, isModifiedClick } from '../services/manageNav';
import { scrollBehavior } from '../services/motion';

interface ArtistsViewProps {
  events: LoggedEvent[];
  onOpenEvent: (id: string) => void;
  onOpenTable: (query: string) => void;
  onManage?: (key: string) => void; // the artist's record in Manage
}

const SORT_KEY = 'livearchive.artistSort.v1';
const SHOWN_EVENTS = 3;

const VIEW_KEY = 'livearchive.artistView.v1';
type Density = 'compact' | 'detailed';

// Remembered choices are a convenience only; storage may be unavailable.
const remember = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do.
  }
};
const readDensity = (): Density => {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'compact' ? 'compact' : 'detailed';
  } catch {
    return 'detailed';
  }
};

const readSort = (): ArtistSort => {
  try {
    const v = window.localStorage.getItem(SORT_KEY);
    return ARTIST_SORTS.some((s) => s.value === v) ? (v as ArtistSort) : 'most';
  } catch {
    return 'most';
  }
};

// A steady colour per artist for the initials, so the same act looks the same everywhere.
const hue = (key: string) => [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (name: string) =>
  name
    .replace(/^the\s+/i, '')
    .split(/[\s&+]+/)
    .filter((w) => /\p{L}|\p{N}/u.test(w))
    .slice(0, 2)
    .map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? '')
    .join('')
    .toUpperCase() || '?';

// One-day events without the weekday, so the dates line up in their column.
const shortWhen = (e: LoggedEvent) =>
  e.startDate && (!e.endDate || e.endDate === e.startDate)
    ? new Date(`${e.startDate}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
    : whenLabel(e);

const groupId = (label: string) => `artists-${label.replace(/[^\w]+/g, '-')}`;

const years = (a: ArtistSummary) =>
  a.firstYear === undefined ? null : a.firstYear === a.lastYear ? String(a.firstYear) : `${a.firstYear} – ${a.lastYear}`;

const Pill: React.FC<{ icon: React.ReactNode; text: string; tone: string; title: string }> = ({ icon, text, tone, title }) => (
  <span title={title} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
    {icon}
    {text}
  </span>
);

const Avatar: React.FC<{ artist: ArtistSummary; small?: boolean }> = ({ artist: a, small }) => (
  <span
    aria-hidden
    className={`flex shrink-0 items-center justify-center rounded-full font-bold text-white/90 ${
      small ? 'h-7 w-7 text-[10px]' : 'mt-0.5 h-10 w-10 text-sm'
    }`}
    style={{ background: `hsl(${hue(a.key)} 45% 32%)` }}
  >
    {initials(a.name)}
  </span>
);

interface ArtistProps {
  artist: ArtistSummary;
  genre?: ArtistGenres;
  onOpenEvent: (id: string) => void;
  onOpenTable: (query: string) => void;
  onManage?: (key: string) => void;
}

// Where an act's genres came from, for the tooltip.
const genreTitle = (g: ArtistGenres) =>
  `${g.genres.map((x) => `${x.style} (${x.parent}) ${Math.round(x.weight * 100)}%`).join(', ')}\nFrom ${
    g.source === 'music-story' ? 'your music-story listening history' : `MusicBrainz: ${g.sourceUrl}`
  }`;

// Compact: one line per artist; tapping it opens the detailed card in place.
const ArtistRow: React.FC<ArtistProps> = ({ artist: a, genre, onOpenEvent, onOpenTable, onManage }) => {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <>
        <li>
          <button
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-1 px-4 pt-2 text-left text-[11px] text-zinc-400 hover:text-zinc-300 sm:px-5"
          >
            <ChevronDown className="h-3 w-3" /> Collapse
          </button>
        </li>
        <ArtistCard artist={a} genre={genre} onOpenEvent={onOpenEvent} onOpenTable={onOpenTable} onManage={onManage} />
      </>
    );
  const span = years(a);
  return (
    <li>
      <button onClick={() => setOpen(true)} className="group flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-zinc-900/60 sm:px-5">
        <Avatar artist={a} small />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-zinc-100">{a.name}</span>
          {a.favourites > 0 && <Heart className="h-3 w-3 shrink-0 fill-current text-rose-400" aria-label="Favourite set" />}
          {a.headlined > 0 && <Crown className="h-3 w-3 shrink-0 text-amber-400" aria-label="Headliner" />}
        </span>
        {genre?.genres.length ? (
          <span className="hidden max-w-[10rem] truncate text-xs text-zinc-400 lg:block" title={genreTitle(genre)}>
            {topStyles(genre, 1)[0]}
          </span>
        ) : null}
        {a.cities.length > 0 && (
          <span className="hidden max-w-[14rem] truncate text-xs text-zinc-400 md:block" title={a.cities.join(', ')}>
            {a.cities[0]}
            {a.cities.length > 1 && ` +${a.cities.length - 1}`}
          </span>
        )}
        <span className="shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-zinc-400 sm:w-24 sm:text-xs">{span}</span>
        <span className="w-8 shrink-0 text-right text-sm font-bold tabular-nums text-zinc-100">{a.events.length}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-700 group-hover:text-zinc-400" />
      </button>
    </li>
  );
};

const ArtistCard: React.FC<ArtistProps> = ({ artist: a, genre, onOpenEvent, onOpenTable, onManage }) => {
  const [open, setOpen] = useState(false);
  const shown = open ? a.events : a.events.slice(0, SHOWN_EVENTS);
  const span = years(a);
  const gaps = artistGaps(a.events, new Date().toISOString().slice(0, 10));
  return (
    <li className="flex gap-4 px-4 py-4 sm:px-5">
      <Avatar artist={a} />
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-semibold text-zinc-100">{a.name}</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-xs text-zinc-400">
              {span && (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="h-3 w-3" />
                  {span}
                </span>
              )}
              {a.cities.length > 0 && (
                <span className="inline-flex min-w-0 items-center gap-1" title={a.cities.join(', ')}>
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {a.cities.slice(0, 2).join(', ')}
                    {a.cities.length > 2 && ` +${a.cities.length - 2}`}
                  </span>
                </span>
              )}
              {genre?.genres.length ? (
                <span className="inline-flex min-w-0 items-center gap-1" title={genreTitle(genre)}>
                  <Tags className="h-3 w-3 shrink-0" />
                  <span className="truncate">{topStyles(genre).join(', ')}</span>
                </span>
              ) : null}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-extrabold leading-none tracking-tight text-zinc-100">{a.events.length}</div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-400">{a.events.length === 1 ? 'time' : 'times'}</div>
          </div>
        </div>

        {gaps.sinceLast !== undefined && (
          <p className="text-xs text-zinc-400" title={gaps.dated < gaps.total ? `Based on the ${gaps.dated} of ${gaps.total} events dated to the day` : undefined}>
            Last seen {gaps.sinceLast === 0 ? 'today' : `${spanLabel(gaps.sinceLast)} ago`}
            {gaps.longest && <> · longest wait {spanLabel(gaps.longest.days)}</>}
          </p>
        )}

        {(a.headlined > 0 || a.supported > 0 || a.favourites > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {a.favourites > 0 && (
              <Pill
                icon={<Heart className="h-3 w-3 fill-current" />}
                text={a.favourites === 1 ? 'Favourite set' : `Favourite set ×${a.favourites}`}
                tone="bg-rose-950/50 text-rose-300"
                title="Events where this was your favourite set"
              />
            )}
            {a.headlined > 0 && (
              <Pill
                icon={<Crown className="h-3 w-3" />}
                text={a.headlined === 1 ? 'Headliner' : `Headliner ×${a.headlined}`}
                tone="bg-amber-950/50 text-amber-300"
                title="Events where they were billed as headliner"
              />
            )}
            {a.supported > 0 && (
              <Pill
                icon={null}
                text={a.supported === 1 ? 'Support' : `Support ×${a.supported}`}
                tone="bg-zinc-800/70 text-zinc-300"
                title="Events where they were billed as support"
              />
            )}
          </div>
        )}

        <ul className="-mx-2 divide-y divide-zinc-900/70">
          {shown.map((e) => (
            <li key={e.id}>
              {/* The date gets its own line on a phone and a column wide enough for "May 15 – 17, 2026" above that. */}
              <button
                onClick={() => onOpenEvent(e.id)}
                className="group flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-900/70 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-zinc-400 sm:w-36">{shortWhen(e) ?? 'Date unknown'}</span>
                <span className="min-w-0 truncate text-zinc-200 group-hover:text-violet-300">
                  <EventTitle event={e} />
                  {e.venue && <span className="text-zinc-400"> · {e.venue}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4 text-xs">
          {a.events.length > SHOWN_EVENTS && (
            <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200">
              <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
              {open ? 'Show fewer' : `${a.events.length - SHOWN_EVENTS} more`}
            </button>
          )}
          {a.events.length > 1 && (
            <button
              onClick={() => onOpenTable(`artist=${encodeURIComponent(a.key)}`)}
              className="inline-flex items-center gap-1 text-zinc-400 hover:text-violet-300"
            >
              <Table2 className="h-3 w-3" /> In the Table
            </button>
          )}
          {onManage && (() => {
            const artistId = a.events.flatMap((e) => e.seen).find((s) => s.key === a.key && s.artistId)?.artistId;
            const manageHref = artistId ? entityUrl('artist', artistId) : buildManageUrl({ scope: 'mine', kind: 'artist', q: a.name });
            return (
              <a
                href={manageHref}
                onClick={(e) => {
                  if (isModifiedClick(e)) return;
                  e.preventDefault();
                  onManage(a.key);
                }}
                className="inline-flex items-center gap-1 text-zinc-400 hover:text-violet-300"
              >
                <FolderCog className="h-3 w-3" /> In Manage
              </a>
            );
          })()}
        </div>
      </div>
    </li>
  );
};

// Everyone you've seen, from the acts you marked on each event, in groups you
// can scan: by how often, when you last or first saw them, or by name.
export const ArtistsView: React.FC<ArtistsViewProps> = ({ events, onOpenEvent, onOpenTable, onManage }) => {
  const [filter, setFilter] = useState('');
  const [sort, setSortState] = useState<ArtistSort>(readSort);
  const setSort = (s: ArtistSort) => {
    setSortState(s);
    remember(SORT_KEY, s);
  };
  const [density, setDensityState] = useState<Density>(readDensity);
  const setDensity = (d: Density) => {
    setDensityState(d);
    remember(VIEW_KEY, d);
  };
  const artists = useMemo(() => artistSummaries(events), [events]);
  // Genres are optional: without them (or before 0013 is applied) the view is unchanged.
  const [genreRows, setGenreRows] = useState<ArtistGenres[]>([]);
  useEffect(() => {
    genresApi
      .list()
      .then((r) => setGenreRows(r.genres))
      .catch(() => setGenreRows([]));
  }, []);
  const genres = useMemo(() => genresByArtist(genreRows), [genreRows]);
  const parents = useMemo(
    () => [...new Set(artists.flatMap((a) => (genres.get(a.key)?.genres ?? []).map((g) => g.parent)))].sort(),
    [artists, genres],
  );
  const [genre, setGenre] = useState('');
  const q = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      groupArtists(
        artists.filter(
          (a) =>
            (!q || a.name.toLowerCase().includes(q)) &&
            (!genre || (genres.get(a.key)?.genres ?? []).some((g) => g.parent === genre)),
        ),
        sort,
      ),
    [artists, q, sort, genre, genres],
  );
  const jumps = useMemo(() => jumpTargets(groups, sort), [groups, sort]);
  // The page header is sticky; the jump bar and group headings sit just under it.
  const [headerHeight, setHeaderHeight] = useState(56);
  useEffect(() => {
    const h = document.querySelector('header');
    if (!h) return;
    const measure = () => setHeaderHeight(h.getBoundingClientRect().height);
    measure();
    const o = new ResizeObserver(measure);
    o.observe(h);
    return () => o.disconnect();
  }, []);
  const barHeight = jumps.length ? 40 : 0;
  // The group whose heading has scrolled under the bars, for the bar's highlight.
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (!jumps.length) return;
    const onScroll = () => {
      let at: string | null = null;
      for (const g of groups) {
        const el = document.getElementById(groupId(g.label));
        if (el && el.getBoundingClientRect().top <= headerHeight + barHeight + 8) at = g.label;
      }
      setCurrent(at);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [groups, jumps.length, headerHeight, barHeight]);
  const jumpTo = (group: string) =>
    document.getElementById(groupId(group))?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });

  const repeat = artists.filter((a) => a.events.length > 1).length;
  const favourites = artists.filter((a) => a.favourites > 0).length;

  if (!artists.length) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-400">
        Nobody yet. Open an event and add who you saw, or find its lineup and tick them.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {[
          [artists.length, artists.length === 1 ? 'Artist' : 'Artists'],
          [repeat, 'Seen more than once'],
          [favourites, 'Favourite sets'],
        ].map(([value, label]) => (
          <div key={label} className="rounded-xl border border-zinc-900 bg-zinc-900/40 px-4 py-3">
            <div className="text-2xl font-extrabold tracking-tight text-zinc-100">{value}</div>
            <div className="text-xs text-zinc-400">{label}</div>
          </div>
        ))}
      </div>

      {/* On a phone the order switch takes its own row under search and the view switch. */}
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Search ${artists.length} artists`}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-4 text-sm placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
          />
        </label>
        {parents.length > 0 && (
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            aria-label="Genre"
            className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 focus:border-violet-500 focus:outline-none"
          >
            <option value="">All genres</option>
            {parents.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        <div role="radiogroup" aria-label="Order" className="order-last flex w-full rounded-xl border border-zinc-800 bg-zinc-900 p-0.5 text-xs sm:order-none sm:w-auto sm:shrink-0">
          {ARTIST_SORTS.map((s) => (
            <button
              key={s.value}
              role="radio"
              aria-checked={sort === s.value}
              onClick={() => setSort(s.value)}
              className={`flex-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 font-medium ${
                sort === s.value ? 'bg-accent-fill text-on-accent' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="View" className="flex shrink-0 rounded-xl border border-zinc-800 bg-zinc-900 p-0.5">
          {(
            [
              ['compact', List, 'Compact'],
              ['detailed', LayoutList, 'Detailed'],
            ] as const
          ).map(([value, Icon, label]) => (
            <Tooltip key={value} label={label}>
              <button
                role="radio"
                aria-checked={density === value}
                aria-label={label}
                onClick={() => setDensity(value)}
                className={`rounded-lg px-2 py-1.5 ${density === value ? 'bg-accent-fill text-on-accent' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {jumps.length > 0 && groups.length > 0 && (
        <nav
          aria-label="Jump to"
          style={{ top: headerHeight }}
          className="sticky z-20 -mx-4 flex h-10 items-center gap-0.5 overflow-x-auto bg-zinc-950 px-4 [scrollbar-width:none]"
        >
          {jumps.map((j) => (
            <button
              key={j.label}
              disabled={!j.group}
              onClick={() => j.group && jumpTo(j.group)}
              className={`shrink-0 rounded-md py-1 text-xs font-semibold tabular-nums ${
                sort === 'az' ? 'min-w-0 flex-1 px-0 sm:min-w-[1.5rem] sm:flex-none sm:px-1.5' : 'px-2.5'
              } ${
                !j.group
                  ? 'text-zinc-700'
                  : j.group === current
                    ? 'bg-accent-fill text-on-accent'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
              }`}
            >
              {j.label}
            </button>
          ))}
        </nav>
      )}

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-400">
          No artist matches{filter ? ` “${filter}”` : ''}{genre ? ` in ${genre}` : ''}.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.label} id={groupId(g.label)} style={{ scrollMarginTop: headerHeight + barHeight }} className="space-y-2">
            <h2 style={{ top: headerHeight + barHeight }} className="sticky z-10 -mx-1 flex items-baseline gap-2 bg-zinc-950 px-1 py-1 text-xs font-bold uppercase tracking-wide text-zinc-400 backdrop-blur">
              {g.label}
              <span className="font-medium normal-case tracking-normal text-zinc-400">{g.artists.length}</span>
            </h2>
            <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900 bg-zinc-900/20">
              {g.artists.map((a) =>
                density === 'compact' ? (
                  <ArtistRow key={a.key} artist={a} genre={genres.get(a.key)} onOpenEvent={onOpenEvent} onOpenTable={onOpenTable} onManage={onManage} />
                ) : (
                  <ArtistCard key={a.key} artist={a} genre={genres.get(a.key)} onOpenEvent={onOpenEvent} onOpenTable={onOpenTable} onManage={onManage} />
                ),
              )}
            </ul>
          </section>
        ))
      )}

    </div>
  );
};
