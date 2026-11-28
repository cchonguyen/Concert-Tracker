import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, Crown, FolderCog, Heart, LayoutList, List, MapPin, Search, Table2, Tags } from 'lucide-react';
import { genresApi, GenresList, LoggedEvent, orbitsApi } from '../services/lineupApi';
import type { ArtistOrbit } from '../server/events/artistOrbits';
import { OrbitSheet, orbitLabel } from './OrbitSheet';
import { ArtistGenres, genresByArtist, hasGenreUnder, topStyles, umbrellaNames } from '../services/genres';
import { artistGaps, spanLabel } from '../services/insights';
import { whenLabel } from '../services/format';
import { EventTitle } from './EventTitle';
import { Ledger } from './ui/Ledger';
import { StubHeader } from './ui/StubHeader';
import { Pill as UiPill } from './ui/Pill';
import { Segmented } from './ui/Segmented';
import { shareGroup } from '../server/events/genreVocabulary';
import { ARTIST_SORTS, artistSummaries, ArtistSort, ArtistSummary, groupArtists, jumpTargets } from '../services/artists';
import { buildManageUrl, entityUrl, isModifiedClick } from '../services/manageNav';
import { rankingByFromParam, type RankingBy } from '../services/nav';
import { scrollBehavior } from '../services/motion';
import { genreKey } from '../server/events/genreVocabulary';
import { GenresRanking } from './GenresRanking';
import { PeopleRanking } from './PeopleRanking';
import { useIsOwner } from './MeContext';
import { PostIt } from './ui/PostIt';

// The count tiles are post-its (docs/specs/landing-look.md): one tilt and tone per tile.
const NOTE_TILTS = [-1.25, 1, -0.75];
const NOTE_TONES = ['paper', 'second', 'accent'] as const;

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
  orbits?: ArtistOrbit[]; // the orbits this act is in (shared, from the owner)
  nameOf?: (key: string) => string;
  onOpenOrbit?: (orbit: ArtistOrbit) => void;
}

// The orbit an act sits in, as a tap target. Shows the first orbit, and "+N" when there are more.
// Inside a row button it is a span with role button, since a button cannot hold a button.
const OrbitPill: React.FC<{ orbits: ArtistOrbit[]; nameOf: (key: string) => string; onOpen: (orbit: ArtistOrbit) => void; nested?: boolean }> = ({
  orbits,
  nameOf,
  onOpen,
  nested,
}) => {
  const first = orbitLabel(orbits[0], nameOf);
  const text = orbits.length > 1 ? `${first} +${orbits.length - 1}` : first;
  const pill = (
    <UiPill tone="accent">
      <span className="truncate">{text}</span>
    </UiPill>
  );
  const cls = 'min-w-0 max-w-[14rem] cursor-pointer rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  if (nested)
    return (
      <span
        role="button"
        tabIndex={0}
        title={`Orbit: ${text}. Tap for the roster.`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen(orbits[0]);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          onOpen(orbits[0]);
        }}
        className={cls}
      >
        {pill}
      </span>
    );
  return (
    <button type="button" title={`Orbit: ${text}. Tap for the roster.`} onClick={() => onOpen(orbits[0])} className={cls}>
      {pill}
    </button>
  );
};

// The genre filter holds a group ("g:" and its name), an umbrella ("u:" and its key), or a style ("s:" and its key).
const GROUP = 'g:';
const FAMILY = 'f:';
const UMBRELLA = 'u:';
const STYLE = 's:';
const matchesGenre = (g: ArtistGenres | undefined, picked: string, vocab: GenresList['vocabulary'] | undefined): boolean =>
  picked.startsWith(UMBRELLA)
    ? hasGenreUnder(g, picked.slice(UMBRELLA.length), vocab)
    : picked.startsWith(STYLE)
      ? (g?.genres ?? []).some((x) => genreKey(x.style) === picked.slice(STYLE.length))
      : picked.startsWith(FAMILY)
        ? (g?.genres ?? []).some((x) => x.family === picked.slice(FAMILY.length))
        : (g?.genres ?? []).some((x) => shareGroup(x) === picked.slice(GROUP.length));
const genreLabel = (picked: string, umbrellas: Array<[string, string]>, styles: Array<[string, string]>): string =>
  picked.startsWith(UMBRELLA)
    ? (umbrellas.find(([k]) => k === picked.slice(UMBRELLA.length))?.[1] ?? picked.slice(UMBRELLA.length))
    : picked.startsWith(STYLE)
      ? (styles.find(([k]) => k === picked.slice(STYLE.length))?.[1] ?? picked.slice(STYLE.length))
      : picked.slice(GROUP.length);

// Where an act's genres came from, for the tooltip.
const genreTitle = (g: ArtistGenres, isOwner: boolean) => {
  const lines = [g.genres.map((x) => `${x.style} (${shareGroup(x)}) ${Math.round(x.weight * 100)}%`).join(', ')];
  if (g.source === 'owner' || g.source === 'you') lines.push(isOwner ? 'Set by you' : 'Set by the site owner');
  else if (g.source === 'music-story') lines.push('From music-story');
  else if (g.source === 'musicbrainz') lines.push(g.sourceUrl ? `From MusicBrainz: ${g.sourceUrl}` : 'From MusicBrainz');
  if (g.added?.length) lines.push(`Added by you: ${g.added.join(', ')}`);
  return lines.join('\n');
};

// Compact: one line per artist; tapping it opens the detailed card in place.
const ArtistRow: React.FC<ArtistProps> = ({ artist: a, genre, onOpenEvent, onOpenTable, onManage, orbits, nameOf, onOpenOrbit }) => {
  const isOwner = useIsOwner();
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <>
        <li>
          <button
            onClick={() => setOpen(false)}
            className="flex min-h-11 w-full items-center gap-1 px-4 pt-2 text-left text-[11px] text-text-muted hover:text-text sm:min-h-9 sm:px-5"
          >
            <ChevronDown className="h-3 w-3" /> Collapse
          </button>
        </li>
        <ArtistCard artist={a} genre={genre} onOpenEvent={onOpenEvent} onOpenTable={onOpenTable} onManage={onManage} orbits={orbits} nameOf={nameOf} onOpenOrbit={onOpenOrbit} />
      </>
    );
  const span = years(a);
  return (
    <Ledger.Row edge="none" onOpen={() => setOpen(true)} className="px-4 py-2 sm:px-5">
      <Avatar artist={a} small />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-text">{a.name}</span>
        {a.favourites > 0 && <Heart className="h-3 w-3 shrink-0 fill-current text-bad" aria-label="Favorite set" />}
        {a.headlined > 0 && <Crown className="h-3 w-3 shrink-0 text-warn" aria-label="Headliner" />}
        {orbits?.length && nameOf && onOpenOrbit ? <OrbitPill orbits={orbits} nameOf={nameOf} onOpen={onOpenOrbit} nested /> : null}
      </span>
      {genre?.genres.length ? (
        <span className="hidden max-w-[10rem] truncate text-xs text-text-muted lg:block" title={genreTitle(genre, isOwner)}>
          {topStyles(genre, 1)[0]}
        </span>
      ) : null}
      {a.cities.length > 0 && (
        <span className="hidden max-w-[14rem] truncate text-xs text-text-muted md:block" title={a.cities.join(', ')}>
          {a.cities[0]}
          {a.cities.length > 1 && ` +${a.cities.length - 1}`}
        </span>
      )}
      <span className="shrink-0 whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-text-muted sm:w-24 sm:text-xs">{span}</span>
      <span className="w-8 shrink-0 text-right font-mono text-sm font-bold tabular-nums text-text">{a.events.length}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint group-hover:text-text-muted" />
    </Ledger.Row>
  );
};

const ArtistCard: React.FC<ArtistProps> = ({ artist: a, genre, onOpenEvent, onOpenTable, onManage, orbits, nameOf, onOpenOrbit }) => {
  const isOwner = useIsOwner();
  const [open, setOpen] = useState(false);
  const shown = open ? a.events : a.events.slice(0, SHOWN_EVENTS);
  const span = years(a);
  const gaps = artistGaps(a.events, new Date().toISOString().slice(0, 10));
  return (
    <Ledger.Row edge="none" className="items-start gap-4 px-4 py-4 sm:px-5">
      <Avatar artist={a} />
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-semibold text-text">{a.name}</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-xs text-text-muted">
              {span && (
                <span className="inline-flex items-center gap-1 font-mono tabular-nums">
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
                <span className="inline-flex min-w-0 items-center gap-1" title={genreTitle(genre, isOwner)}>
                  <Tags className="h-3 w-3 shrink-0" />
                  <span className="truncate">{topStyles(genre).join(', ')}</span>
                </span>
              ) : null}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-xl font-extrabold leading-none tracking-tight tabular-nums text-text">{a.events.length}</div>
            <div className="text-[10px] uppercase tracking-wide text-text-muted">{a.events.length === 1 ? 'time' : 'times'}</div>
          </div>
        </div>

        {gaps.sinceLast !== undefined && (
          <p className="text-xs text-text-muted" title={gaps.dated < gaps.total ? `Based on the ${gaps.dated} of ${gaps.total} events dated to the day` : undefined}>
            Last seen {gaps.sinceLast === 0 ? 'today' : `${spanLabel(gaps.sinceLast)} ago`}
            {gaps.longest && <> · longest wait {spanLabel(gaps.longest.days)}</>}
          </p>
        )}

        {(a.headlined > 0 || a.supported > 0 || a.favourites > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {a.favourites > 0 && (
              <Pill
                icon={<Heart className="h-3 w-3 fill-current" />}
                text={a.favourites === 1 ? 'Favorite set' : `Favorite set ×${a.favourites}`}
                tone="border border-bad/45 bg-bad/10 text-bad"
                title="Events where this was your favorite set"
              />
            )}
            {a.headlined > 0 && (
              <span title="Events where they were billed as headliner">
                <UiPill tone="highlight">
                  <Crown className="h-3 w-3" />
                  {a.headlined === 1 ? 'Headliner' : `Headliner ×${a.headlined}`}
                </UiPill>
              </span>
            )}
            {a.supported > 0 && (
              <span title="Events where they were billed as support">
                <UiPill tone="neutral">{a.supported === 1 ? 'Support' : `Support ×${a.supported}`}</UiPill>
              </span>
            )}
          </div>
        )}

        {orbits?.length && nameOf && onOpenOrbit ? (
          <div className="flex flex-wrap gap-1.5">
            <OrbitPill orbits={orbits} nameOf={nameOf} onOpen={onOpenOrbit} />
          </div>
        ) : null}

        <ul className="-mx-2 divide-y divide-line">
          {shown.map((e) => (
            <li key={e.id}>
              {/* The date gets its own line on a phone and a column wide enough for "May 15 – 17, 2026" above that. */}
              <button
                onClick={() => onOpenEvent(e.id)}
                className="group flex min-h-11 w-full flex-col gap-0.5 rounded-control px-2 py-1.5 text-left text-sm row-hover sm:min-h-9 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-text-muted sm:w-36">{shortWhen(e) ?? 'Date unknown'}</span>
                <span className="min-w-0 truncate text-text group-hover:text-accent">
                  <EventTitle event={e} />
                  {e.venue && <span className="text-text-muted"> · {e.venue}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4 text-xs">
          {a.events.length > SHOWN_EVENTS && (
            <button onClick={() => setOpen((o) => !o)} className="inline-flex min-h-11 items-center gap-1 text-text-muted hover:text-text sm:min-h-9">
              <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
              {open ? 'Show fewer' : `${a.events.length - SHOWN_EVENTS} more`}
            </button>
          )}
          {a.events.length > 1 && (
            <button
              onClick={() => onOpenTable(`artist=${encodeURIComponent(a.key)}`)}
              className="inline-flex min-h-11 items-center gap-1 text-text-muted hover:text-accent sm:min-h-9"
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
                className="inline-flex min-h-11 items-center gap-1 text-text-muted hover:text-accent sm:min-h-9"
              >
                <FolderCog className="h-3 w-3" /> In Manage
              </a>
            );
          })()}
        </div>
      </div>
    </Ledger.Row>
  );
};

// Everyone you've seen, from the acts you marked on each event, in groups you
// can scan: by how often, when you last or first saw them, or by name.
export const ArtistsView: React.FC<ArtistsViewProps> = ({ events, onOpenEvent, onOpenTable, onManage }) => {
  const [by, setByState] = useState<RankingBy>(() =>
    rankingByFromParam(typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('by') : null),
  );
  const setBy = (next: RankingBy) => {
    setByState(next);
    if (typeof window === 'undefined') return;
    const url = next === 'artists' ? `${window.location.pathname}?view=ranking` : `${window.location.pathname}?view=ranking&by=${next}`;
    window.history.replaceState(null, '', url);
  };
  useEffect(() => {
    const onPop = () => {
      setByState(rankingByFromParam(new URLSearchParams(window.location.search).get('by')));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
  const [genreData, setGenreData] = useState<Pick<GenresList, 'genres' | 'vocabulary' | 'map'> | null>(null);
  useEffect(() => {
    genresApi
      .list()
      .then((r) => setGenreData({ genres: r.genres, vocabulary: r.vocabulary, map: r.map }))
      .catch(() => setGenreData(null));
  }, []);
  const vocabulary = genreData?.vocabulary;
  // Orbits are optional too: on a failure, or with none, nothing new shows.
  const [orbits, setOrbits] = useState<ArtistOrbit[]>([]);
  useEffect(() => {
    orbitsApi
      .list()
      .then((r) => setOrbits(Array.isArray(r) ? r : []))
      .catch(() => setOrbits([]));
  }, []);
  const [openOrbit, setOpenOrbit] = useState<ArtistOrbit | null>(null);
  const nameByKey = useMemo(() => new Map(artists.map((a) => [a.key, a.name])), [artists]);
  const nameOf = (key: string) => nameByKey.get(key) ?? key;
  const seenKeys = useMemo(() => new Set(artists.map((a) => a.key)), [artists]);
  const orbitsByKey = useMemo(() => {
    const map = new Map<string, ArtistOrbit[]>();
    for (const o of orbits) for (const m of o.members) map.set(m.artistKey, [...(map.get(m.artistKey) ?? []), o]);
    return map;
  }, [orbits]);
  const genres = useMemo(
    () => genresByArtist(genreData?.genres ?? [], genreData?.vocabulary, genreData?.map),
    [genreData],
  );
  const parents = useMemo(
    () => [...new Set(artists.flatMap((a) => (genres.get(a.key)?.genres ?? []).map((g) => shareGroup(g))))].sort(),
    [artists, genres],
  );
  // The top-level groups are already families when the taxonomy is in use; list only the rest.
  const families = useMemo(
    () =>
      [...new Set(artists.flatMap((a) => (genres.get(a.key)?.genres ?? []).flatMap((g) => (g.family ? [g.family] : []))))]
        .filter((f) => !parents.includes(f))
        .sort(),
    [artists, genres, parents],
  );
  // Umbrellas that at least one artist here falls under; picking one shows the
  // artists with it or any genre under it. Pills still show only their own genres.
  const umbrellas = useMemo(
    () =>
      [...umbrellaNames(vocabulary)]
        .filter(([key]) => artists.some((a) => hasGenreUnder(genres.get(a.key), key, vocabulary)))
        .sort((a, b) => a[1].localeCompare(b[1])),
    [artists, genres, vocabulary],
  );
  const styles = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of artists) {
      for (const x of genres.get(a.key)?.genres ?? []) {
        const k = genreKey(x.style);
        if (k && !map.has(k)) map.set(k, x.style);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [artists, genres]);
  const [genre, setGenre] = useState('');
  const q = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      groupArtists(
        artists.filter(
          (a) =>
            (!q || a.name.toLowerCase().includes(q)) &&
            (!genre || matchesGenre(genres.get(a.key), genre, vocabulary)),
        ),
        sort,
      ),
    [artists, q, sort, genre, genres, vocabulary],
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
      <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-text-muted">
        Nobody yet. Open an event and add who you saw, or find its lineup and tick them.
      </p>
    );
  }

  const rankingSwitch = (
    <Segmented
      label="Ranking view"
      compact
      value={by}
      onChange={setBy}
      options={[
        { value: 'artists', label: 'Artists' },
        { value: 'genres', label: 'Genres' },
        { value: 'people', label: 'People' },
      ]}
    />
  );

  if (by === 'genres') {
    return (
      <div className="space-y-4">
        {rankingSwitch}
        <GenresRanking
          events={events}
          byArtist={genres}
          vocabulary={vocabulary}
          onOpenArtistsWithGenre={(f) => {
            setGenre(f);
            setBy('artists');
          }}
        />
      </div>
    );
  }

  if (by === 'people') {
    return (
      <div className="space-y-4">
        {rankingSwitch}
        <PeopleRanking events={events} byArtist={genres} vocabulary={vocabulary} onOpenTable={onOpenTable} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {rankingSwitch}
      <div className="grid grid-cols-3 gap-3 pt-2 sm:gap-4">
        {[
          [artists.length, artists.length === 1 ? 'Artist' : 'Artists'],
          [repeat, 'Seen more than once'],
          [favourites, 'Favorite sets'],
        ].map(([value, label], i) => (
          <PostIt key={label} tilt={NOTE_TILTS[i]} tone={NOTE_TONES[i]} delay={i * 0.06} className="h-full !px-3 !py-4 sm:!px-4">
            <div className="poster-head text-4xl leading-none tabular-nums">{value}</div>
            <div className="mt-1 font-mono text-xs">{label}</div>
          </PostIt>
        ))}
      </div>

      {/* On a phone the order switch takes its own row under search and the view switch. */}
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Search ${artists.length} artists`}
            className="min-h-11 w-full rounded-control border border-line-strong bg-surface-1 py-2 pl-9 pr-4 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9"
          />
        </label>
        {(parents.length > 0 || families.length > 0 || umbrellas.length > 0 || styles.length > 0) && (
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            aria-label="Genre"
            className="min-h-11 shrink-0 rounded-control border border-line-strong bg-surface-1 px-3 py-2 text-sm text-text focus:border-accent focus:outline-none sm:min-h-9"
          >
            <option value="">All genres</option>
            {parents.map((p) => (
              <option key={p} value={GROUP + p}>
                {p}
              </option>
            ))}
            {families.length > 0 && (
              <optgroup label="Families">
                {families.map((f) => (
                  <option key={f} value={FAMILY + f}>
                    {f}
                  </option>
                ))}
              </optgroup>
            )}
            {umbrellas.length > 0 && (
              <optgroup label="Including related genres">
                {umbrellas.map(([key, name]) => (
                  <option key={key} value={UMBRELLA + key}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
            {styles.length > 0 && (
              <optgroup label="Styles">
                {styles.map(([key, name]) => (
                  <option key={key} value={STYLE + key}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}
        <Segmented
          label="Order"
          value={sort}
          onChange={setSort}
          stretch
          compact
          className="order-last w-full flex-nowrap! sm:order-none sm:w-auto sm:shrink-0"
          options={ARTIST_SORTS.map((s) => ({ value: s.value, label: s.label }))}
        />
        <Segmented
          label="View"
          value={density}
          onChange={setDensity}
          iconOnly
          className="shrink-0 flex-nowrap!"
          options={[
            { value: 'compact', label: 'Compact', icon: List },
            { value: 'detailed', label: 'Detailed', icon: LayoutList },
          ]}
        />
      </div>

      {jumps.length > 0 && groups.length > 0 && (
        <nav
          aria-label="Jump to"
          style={{ top: headerHeight }}
          className="sticky z-20 -mx-4 flex h-11 items-center gap-0.5 overflow-x-auto bg-page px-4 [scrollbar-width:none]"
        >
          {jumps.map((j) => (
            <button
              key={j.label}
              disabled={!j.group}
              onClick={() => j.group && jumpTo(j.group)}
              className={`min-h-9 shrink-0 rounded-control py-1 font-mono text-xs font-semibold tabular-nums ${
                sort === 'az' ? 'min-w-0 flex-1 px-0 sm:min-w-[1.5rem] sm:flex-none sm:px-1.5' : 'px-2.5'
              } ${
                !j.group
                  ? 'text-text-faint'
                  : j.group === current
                    ? 'bg-accent-fill text-on-accent'
                    : 'text-text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              {j.label}
            </button>
          ))}
        </nav>
      )}

      {groups.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-text-muted">
          No artist matches{filter ? ` “${filter}”` : ''}{genre ? ` in ${genreLabel(genre, umbrellas, styles)}` : ''}.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.label} id={groupId(g.label)} style={{ scrollMarginTop: headerHeight + barHeight }}>
            <StubHeader title={<h2 className="m-0 inline font-normal">{g.label}</h2>} segments={[{ k: 'ARTISTS', v: g.artists.length }]}>
              <Ledger bare>
                {g.artists.map((a) =>
                  density === 'compact' ? (
                    <ArtistRow key={a.key} artist={a} genre={genres.get(a.key)} onOpenEvent={onOpenEvent} onOpenTable={onOpenTable} onManage={onManage} orbits={orbitsByKey.get(a.key)} nameOf={nameOf} onOpenOrbit={setOpenOrbit} />
                  ) : (
                    <ArtistCard key={a.key} artist={a} genre={genres.get(a.key)} onOpenEvent={onOpenEvent} onOpenTable={onOpenTable} onManage={onManage} orbits={orbitsByKey.get(a.key)} nameOf={nameOf} onOpenOrbit={setOpenOrbit} />
                  ),
                )}
              </Ledger>
            </StubHeader>
          </section>
        ))
      )}

      {openOrbit && (
        <OrbitSheet
          orbit={openOrbit}
          nameOf={nameOf}
          seen={seenKeys}
          events={events}
          onOpenEvent={onOpenEvent}
          onClose={() => setOpenOrbit(null)}
        />
      )}
    </div>
  );
};
