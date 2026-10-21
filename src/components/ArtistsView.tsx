import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, Crown, Heart, MapPin, Search, Table2 } from 'lucide-react';
import type { LoggedEvent } from '../services/lineupApi';
import { whenLabel } from '../services/format';
import { EventTitle } from './EventTitle';
import { ARTIST_SORTS, artistSummaries, ArtistSort, ArtistSummary, groupArtists, jumpTargets } from '../services/artists';

interface ArtistsViewProps {
  events: LoggedEvent[];
  onOpenEvent: (id: string) => void;
  onOpenTable: (query: string) => void;
}

const SORT_KEY = 'livearchive.artistSort.v1';
const SHOWN_EVENTS = 3;

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

const ArtistCard: React.FC<{ artist: ArtistSummary; onOpenEvent: (id: string) => void; onOpenTable: (query: string) => void }> = ({
  artist: a,
  onOpenEvent,
  onOpenTable,
}) => {
  const [open, setOpen] = useState(false);
  const shown = open ? a.events : a.events.slice(0, SHOWN_EVENTS);
  const span = years(a);
  return (
    <li className="flex gap-4 px-4 py-4 sm:px-5">
      <span
        aria-hidden
        className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white/90"
        style={{ background: `hsl(${hue(a.key)} 45% 32%)` }}
      >
        {initials(a.name)}
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-semibold text-zinc-100">{a.name}</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-xs text-zinc-500">
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
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-extrabold leading-none tracking-tight text-zinc-100">{a.events.length}</div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">{a.events.length === 1 ? 'time' : 'times'}</div>
          </div>
        </div>

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
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-zinc-500 sm:w-36">{shortWhen(e) ?? 'Date unknown'}</span>
                <span className="min-w-0 truncate text-zinc-200 group-hover:text-violet-300">
                  <EventTitle event={e} />
                  {e.venue && <span className="text-zinc-600"> · {e.venue}</span>}
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
              className="inline-flex items-center gap-1 text-zinc-500 hover:text-violet-300"
            >
              <Table2 className="h-3 w-3" /> In the Table
            </button>
          )}
        </div>
      </div>
    </li>
  );
};

// Everyone you've seen, from the acts you marked on each event, in groups you
// can scan: by how often, when you last or first saw them, or by name.
export const ArtistsView: React.FC<ArtistsViewProps> = ({ events, onOpenEvent, onOpenTable }) => {
  const [filter, setFilter] = useState('');
  const [sort, setSortState] = useState<ArtistSort>(readSort);
  const setSort = (s: ArtistSort) => {
    setSortState(s);
    try {
      window.localStorage.setItem(SORT_KEY, s);
    } catch {
      // Remembering the order is a convenience only.
    }
  };
  const artists = useMemo(() => artistSummaries(events), [events]);
  const q = filter.trim().toLowerCase();
  const groups = useMemo(
    () => groupArtists(q ? artists.filter((a) => a.name.toLowerCase().includes(q)) : artists, sort),
    [artists, q, sort],
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
    document.getElementById(groupId(group))?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const repeat = artists.filter((a) => a.events.length > 1).length;
  const favourites = artists.filter((a) => a.favourites > 0).length;

  if (!artists.length) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
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
            <div className="text-xs text-zinc-500">{label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Search ${artists.length} artists`}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-4 text-sm placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
          />
        </label>
        <div role="radiogroup" aria-label="Order" className="flex shrink-0 rounded-xl border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
          {ARTIST_SORTS.map((s) => (
            <button
              key={s.value}
              role="radio"
              aria-checked={sort === s.value}
              onClick={() => setSort(s.value)}
              className={`flex-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 font-medium ${
                sort === s.value ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {s.label}
            </button>
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
                    ? 'bg-violet-600 text-white'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
              }`}
            >
              {j.label}
            </button>
          ))}
        </nav>
      )}

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No artist matches “{filter}”.</p>
      ) : (
        groups.map((g) => (
          <section key={g.label} id={groupId(g.label)} style={{ scrollMarginTop: headerHeight + barHeight }} className="space-y-2">
            <h2 style={{ top: headerHeight + barHeight }} className="sticky z-10 -mx-1 flex items-baseline gap-2 bg-zinc-950 px-1 py-1 text-xs font-bold uppercase tracking-wide text-zinc-400 backdrop-blur">
              {g.label}
              <span className="font-medium normal-case tracking-normal text-zinc-600">{g.artists.length}</span>
            </h2>
            <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900 bg-zinc-900/20">
              {g.artists.map((a) => (
                <ArtistCard key={a.key} artist={a} onOpenEvent={onOpenEvent} onOpenTable={onOpenTable} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
};
