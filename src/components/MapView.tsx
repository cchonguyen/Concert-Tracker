import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Pause, Play, Table2, X } from 'lucide-react';
import { eventsApi, LineupFacts, LineupSummary, LoggedEvent } from '../services/lineupApi';
import { eventYear, whenLabel } from '../services/format';
import { EMPTY_FILTERS, filterEvents, filterOptions, filtersFromQuery, filtersToQuery, TableFilters } from '../services/table';
import { mapData, MapPlace, placeKey, placeQuery, playbackYears, Points, trail, travel } from '../services/map';
import { eventTitle } from '../services/series';

interface MapViewProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  onOpen: (id: string) => void;
  onOpenTable: (query: string) => void;
}

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const label = 'space-y-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// City points are kept in this browser so the geocoder is asked once per city.
const CACHE_KEY = 'livearchive.cityPoints.v1';
const loadPoints = (): Points => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
  } catch {
    return {};
  }
};
const savePoints = (p: Points) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(p));
  } catch {
    // Storage full or blocked: the map still works, it just asks again next time.
  }
};

// Looks up each city you stored once, a few at a time.
function useCityPoints(events: LoggedEvent[]): Points {
  const [points, setPoints] = useState<Points>(loadPoints);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const keys = [...new Set(events.map(placeKey).filter((k): k is string => Boolean(k)))].filter(
      (k) => !(k in points) && !asked.current.has(k),
    );
    if (!keys.length) return;
    keys.forEach((k) => asked.current.add(k));
    let cancelled = false;
    const queue = [...keys];
    const work = async () => {
      while (queue.length && !cancelled) {
        const key = queue.shift()!;
        const { city, country } = placeQuery(key);
        try {
          const point = await eventsApi.cityPoint(city, country);
          setPoints((p) => {
            const next = { ...p, [key]: point };
            savePoints(next);
            return next;
          });
        } catch {
          // Left out of the map this time; asked again on the next visit.
        }
      }
    };
    void Promise.all([work(), work(), work()]);
    return () => {
      cancelled = true;
    };
  }, [events, points]);
  return points;
}

const Select: React.FC<{
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}> = ({ name, value, onChange, options }) => (
  <label className={label}>
    <span>{name}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className={control}>
      <option value="">Any</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </label>
);

const readQuery = () => filtersFromQuery(window.location.search);

export const MapView: React.FC<MapViewProps> = ({ events, lineups, editions, onOpen, onOpenTable }) => {
  const [filters, setFilters] = useState<TableFilters>(readQuery);
  const [selected, setSelected] = useState<string | null>(null);
  const [playYear, setPlayYear] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const points = useCityPoints(events);
  const options = useMemo(() => filterOptions(events), [events]);
  const filtered = useMemo(() => filterEvents(events, filters, lineups, editions), [events, filters, lineups, editions]);
  const years = useMemo(() => playbackYears(filtered), [filtered]);
  const shown = useMemo(
    () => (playYear === null ? filtered : filtered.filter((e) => (eventYear(e) ?? Infinity) <= playYear)),
    [filtered, playYear],
  );
  const data = useMemo(() => mapData(shown, points), [shown, points]);
  const all = useMemo(() => mapData(filtered, points), [filtered, points]);
  const counts = travel(data.places);
  const stops = useMemo(() => (filters.artist ? trail(shown, filters.artist, points) : []), [shown, filters.artist, points]);
  const approximate = data.places.filter((p) => p.point.match === 'name');
  const place = data.places.find((p) => p.key === selected) ?? null;

  const set = (patch: Partial<TableFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPlayYear(null);
    setPlaying(false);
  };
  const year = (s: string) => (s ? Number(s) : undefined);

  useEffect(() => {
    const q = filtersToQuery(filters);
    window.history.replaceState(null, '', `${window.location.pathname}?view=map${q ? `&${q}` : ''}`);
  }, [filters]);

  // Year playback: one year a second, adding each year's events to the map.
  useEffect(() => {
    if (!playing) return;
    const next = playYear === null ? years[0] : years.find((y) => y > playYear);
    if (next === undefined) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setPlayYear(next), playYear === null ? 0 : 1000);
    return () => clearTimeout(t);
  }, [playing, playYear, years]);

  // The map itself, made once.
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!box.current || map.current) return;
    map.current = L.map(box.current, { worldCopyJump: true, zoomControl: true }).setView([30, -40], 2);
    // OpenStreetMap's own tiles need no key; the map-tiles class darkens them in CSS.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: 'map-tiles',
      maxZoom: 19,
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Bubbles sized by events per city, and the trail for one act.
  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.clearLayers();
    const max = Math.max(1, ...data.places.map((p) => p.events.length));
    for (const p of [...data.places].reverse()) {
      const n = p.events.length;
      L.circleMarker([p.point.lat, p.point.lon], {
        radius: 5 + 17 * Math.sqrt(n / max),
        color: p.key === selected ? '#ffffff' : '#c4b5fd',
        weight: p.key === selected ? 2 : 1,
        fillColor: '#8b5cf6',
        fillOpacity: 0.55,
      })
        .bindTooltip(`${p.city}: ${plural(n, 'event')}${p.point.match === 'name' ? ' (placed by name only)' : ''}`)
        .on('click', () => setSelected(p.key))
        .addTo(group);
    }
    if (stops.length > 1) {
      L.polyline(
        stops.map((s) => [s.point.lat, s.point.lon] as L.LatLngTuple),
        { color: '#22d3ee', weight: 2, opacity: 0.8, dashArray: '4 6' },
      ).addTo(group);
    }
  }, [data, selected, stops]);

  // Fit to the filtered places when the filters change, not during playback.
  useEffect(() => {
    if (!map.current || !all.places.length) return;
    const bounds = L.latLngBounds(all.places.map((p) => [p.point.lat, p.point.lon] as L.LatLngTuple));
    map.current.fitBounds(bounds.pad(0.2), { maxZoom: 9 });
  }, [all.places.length, filters]);

  const tableQuery = filtersToQuery({ ...filters, sort: EMPTY_FILTERS.sort, desc: EMPTY_FILTERS.desc });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={`${label} col-span-2 sm:col-span-3 lg:col-span-2`}>
          <span>Search</span>
          <input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Events, venues, acts, people" className={control} />
        </label>
        <Select
          name="From year"
          value={filters.yearFrom ? String(filters.yearFrom) : ''}
          onChange={(v) => set({ yearFrom: year(v) })}
          options={options.years.map((y) => ({ value: String(y), label: String(y) }))}
        />
        <Select
          name="To year"
          value={filters.yearTo ? String(filters.yearTo) : ''}
          onChange={(v) => set({ yearTo: year(v) })}
          options={options.years.map((y) => ({ value: String(y), label: String(y) }))}
        />
        <Select
          name="Saw"
          value={filters.artist}
          onChange={(v) => set({ artist: v })}
          options={options.artists.map((a) => ({ value: a.key, label: a.name }))}
        />
        <Select
          name="Type"
          value={filters.kind === 'any' ? '' : filters.kind}
          onChange={(v) => set({ kind: (v || 'any') as TableFilters['kind'] })}
          options={[
            { value: 'concert', label: 'Concert' },
            { value: 'festival', label: 'Festival' },
            { value: 'unknown', label: 'Not known yet' },
          ]}
        />
        {options.formats.length > 0 && (
          <Select name="Format" value={filters.format} onChange={(v) => set({ format: v })} options={options.formats.map((v) => ({ value: v, label: v }))} />
        )}
        {options.series.length > 0 && (
          <Select name="Series" value={filters.series} onChange={(v) => set({ series: v })} options={options.series.map((v) => ({ value: v, label: v }))} />
        )}
        {options.companions.length > 0 && (
          <Select
            name="Went with"
            value={filters.companion}
            onChange={(v) => set({ companion: v })}
            options={options.companions.map((v) => ({ value: v, label: v }))}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <span>
          {counts.cities} {counts.cities === 1 ? 'city' : 'cities'} · {counts.regions} {counts.regions === 1 ? 'state or province' : 'states or provinces'} ·{' '}
          {counts.countries} {counts.countries === 1 ? 'country' : 'countries'}
          {' · '}
          {plural(data.places.reduce((a, p) => a + p.events.length, 0), 'event')} on the map
          {data.pending > 0 && <span className="text-zinc-500"> · placing {data.pending} more</span>}
        </span>
        <span className="flex items-center gap-3">
          {years.length > 1 && (
            <button
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (playYear !== null && playYear >= years[years.length - 1]) setPlayYear(null);
                  setPlaying(true);
                }
              }}
              className="inline-flex items-center gap-1.5 text-violet-300 hover:text-violet-200"
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {playing ? 'Pause' : playYear === null ? 'Play the years' : 'Resume'}
            </button>
          )}
          {playYear !== null && !playing && (
            <button onClick={() => setPlayYear(null)} className="inline-flex items-center gap-1 hover:text-zinc-200">
              <X className="h-3.5 w-3.5" /> Show all years
            </button>
          )}
          <button onClick={() => onOpenTable(tableQuery)} className="inline-flex items-center gap-1.5 hover:text-zinc-200">
            <Table2 className="h-3.5 w-3.5" /> These events in the Table
          </button>
        </span>
      </div>

      <div className="relative isolate overflow-hidden rounded-xl border border-zinc-900">
        <div ref={box} className="h-[60vh] min-h-[320px] w-full bg-zinc-950" />
        {playYear !== null && (
          <div className="pointer-events-none absolute right-3 top-3 z-[500] rounded-lg bg-zinc-950/80 px-3 py-1 text-2xl font-extrabold text-zinc-100">
            {playYear}
          </div>
        )}
      </div>

      {place && <PlacePanel place={place} onOpen={onOpen} onClose={() => setSelected(null)} onOpenTable={onOpenTable} />}

      {stops.length > 0 && (
        <section className="space-y-1 text-sm">
          <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-500">
            Trail: {options.artists.find((a) => a.key === filters.artist)?.name}
          </h2>
          <ol className="flex flex-wrap gap-x-2 gap-y-1 text-zinc-300">
            {stops.map((s, i) => (
              <li key={s.event.id}>
                <button onClick={() => onOpen(s.event.id)} className="hover:text-violet-300 hover:underline">
                  {i + 1}. {s.event.city}
                  <span className="text-zinc-500">{whenLabel(s.event) ? `, ${whenLabel(s.event)}` : ''}</span>
                </button>
                {i < stops.length - 1 && <span className="ml-2 text-zinc-600">→</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="space-y-1 text-xs text-zinc-500">
        {data.noCity > 0 && (
          <p>{plural(data.noCity, 'event')} without a city not shown. Fill gaps in the Table can add them.</p>
        )}
        {data.notFound.length > 0 && (
          <p>
            Could not place {[...new Set(data.notFound.map((e) => e.city))].join(', ')}. Writing the city as "City, ST" or "City, Country" helps.
          </p>
        )}
        {approximate.length > 0 && (
          <p>
            Placed by name only, as the biggest place called that: {approximate.map((p) => p.city).join(', ')}. Add a state or country to be sure.
          </p>
        )}
        <p>Each dot is a city, from the city you stored on the event; its size is how many events you went to there.</p>
      </div>
    </div>
  );
};

const PlacePanel: React.FC<{ place: MapPlace; onOpen: (id: string) => void; onClose: () => void; onOpenTable: (q: string) => void }> = ({
  place,
  onOpen,
  onClose,
  onOpenTable,
}) => (
  <section className="space-y-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold text-zinc-100">
        {place.city} <span className="text-xs font-normal text-zinc-500">{plural(place.events.length, 'event')}</span>
      </h2>
      <span className="flex items-center gap-3 text-xs">
        <button onClick={() => onOpenTable(`city=${encodeURIComponent(place.city)}`)} className="text-zinc-400 hover:text-zinc-200">
          Open in Table
        </button>
        <button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-200">
          <X className="h-4 w-4" />
        </button>
      </span>
    </div>
    <ul className="divide-y divide-zinc-900">
      {place.events.map((e) => (
        <li key={e.id}>
          <button onClick={() => onOpen(e.id)} className="flex w-full items-baseline justify-between gap-3 py-1.5 text-left text-sm hover:text-violet-300">
            <span className="truncate text-zinc-200">
              {eventTitle(e)}
              {e.venue && <span className="text-zinc-500"> · {e.venue}</span>}
            </span>
            <span className="shrink-0 text-xs text-zinc-500">{whenLabel(e) ?? 'Date unknown'}</span>
          </button>
        </li>
      ))}
    </ul>
  </section>
);
