import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, CloudSun, ExternalLink, Heart, Link2, Loader2, Plus, RefreshCw, Search, Star, Trash2, X } from 'lucide-react';
import {
  ArtistSuggestion,
  DetailCandidate,
  Edition,
  EventField,
  EventPatch,
  eventsApi,
  isActive,
  lineupApi,
  LoggedEvent,
  LookupJob,
  PlaceGuess,
  SOURCE_LABELS,
} from '../services/lineupApi';
import { artistsOf, dateConfirmations, datesBetween, matchNames, pastArtistNames, pastCompanionNames, supportOf, weatherLine, whenLabel } from '../services/format';
import { actSets, setLabel } from '../server/events/sets';
import { eventScale, KIND_LABELS, lineupFacts } from '../server/events/scale';
import { LineupReview } from './LineupReview';
import { norm } from '../services/listImport';
import { leaveB2b, pairB2b, seenSlots, SET_LABELS, toSeenInput } from '../server/events/seen';
import { eventTitle, seriesList, seriesOffers, weekendFromName } from '../services/series';
import { placePatch } from '../services/table';
import { cityWithRegion } from '../server/events/regions';

interface EventDetailProps {
  event: LoggedEvent;
  // Your whole log, for venue and city suggestions.
  events: LoggedEvent[];
  onChange: (event: LoggedEvent) => void;
  onDeleted: () => void;
  onClose: () => void;
}

const input =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-500';

// A text field that saves when you leave it.
const Field: React.FC<{
  label: string;
  value?: string | number;
  type?: string;
  placeholder?: string;
  source?: LoggedEvent['sources'][keyof LoggedEvent['sources']];
  onSave: (value: string) => void;
  onType?: (value: string) => void;
  suggestions?: string[];
  // A confirmed source gives a different value: one tap takes it.
  offer?: { value: string; from: string; onUse: () => void };
  min?: string;
  className?: string;
}> = ({ label, value, type = 'text', placeholder, source, onSave, onType, suggestions, offer, min, className }) => {
  const listId = React.useId();
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  return (
    <label className={`space-y-1 ${className ?? ''}`}>
      <span className="flex items-center justify-between gap-2 text-[11px] font-semibold text-zinc-400">
        {label}
        {source && source.sourceType !== 'user' && (
          <a
            href={source.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title={source.quote ? `“${source.quote}”` : undefined}
            className="inline-flex items-center gap-0.5 font-normal text-zinc-500 hover:text-violet-300"
          >
            via {SOURCE_LABELS[source.sourceType]} <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </span>
      <input
        className={input}
        type={type}
        value={draft}
        min={min}
        placeholder={placeholder}
        list={suggestions?.length ? listId : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          onType?.(e.target.value);
        }}
        onBlur={() => draft !== (value === undefined ? '' : String(value)) && onSave(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {offer && (
        <button type="button" onClick={offer.onUse} className="block w-full truncate text-left text-[11px] text-violet-300 hover:underline">
          Use “{offer.value}” from {offer.from}
        </button>
      )}
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </label>
  );
};

// Chips with an input to add more (companions). Typing offers names you've
// entered on other events; a click, or arrow keys then Enter, adds one as you
// spelled it before. Enter alone adds what you typed.
const ChipInput: React.FC<{
  items: string[];
  placeholder: string;
  past: string[];
  label: string;
  onChange: (items: string[]) => void;
}> = ({ items, placeholder, past, label, onChange }) => {
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(-1);
  const matches = matchNames(draft, past, new Set(items.map(norm)));
  const addNames = (names: string[]) => {
    if (names.length) onChange([...items, ...names]);
    setDraft('');
    setActive(-1);
  };
  const add = () => addNames(draft.split(',').map((s) => s.trim()).filter(Boolean));
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => (
          <span key={`${item}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-zinc-800 py-1 pl-2.5 pr-1.5 text-sm text-zinc-100">
            {item}
            <button onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${item}`} className="text-zinc-500 hover:text-zinc-200">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && matches.length) {
              e.preventDefault();
              setActive((i) => (i + 1) % matches.length);
            } else if (e.key === 'ArrowUp' && matches.length) {
              e.preventDefault();
              setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
            } else if (e.key === 'Enter' && matches[active]) {
              e.preventDefault();
              addNames([matches[active]]);
            } else if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Escape') setDraft('');
          }}
          onBlur={add}
          placeholder={placeholder}
          aria-label={label}
          className="min-w-[8rem] flex-1 bg-transparent px-1.5 py-1 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
        />
      </div>
      {matches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1 pt-1.5" role="listbox" aria-label="Names you've entered before">
          <span className="text-[11px] text-zinc-500">Before:</span>
          {matches.map((name, i) => (
            <button
              key={name}
              role="option"
              aria-selected={i === active}
              // mousedown, so the input's blur doesn't add the half-typed text first
              onMouseDown={(e) => {
                e.preventDefault();
                addNames([name]);
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                i === active ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-700 text-zinc-300 hover:border-violet-500'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

type Seen = LoggedEvent['seen'][number];
type SeenPatch = NonNullable<EventPatch['seen']>;

const toPatch = (seen: Seen[]): SeenPatch => toSeenInput(seen);
const NEXT_SET: Record<string, Seen['set'] | null> = { none: 'dj', dj: 'live', live: null };

// Who you saw, in two rows: Artist (headliners and acts with no role stated)
// and Supporting (acts billed as support). Moving an act, or tapping its name
// to mark it headliner, sets its role as yours.
// The heart marks your favourite set of the night; sets shows each act's
// stage and time where a source times it.
// The set button cycles DJ set, live set and unmarked. The link button pairs
// acts as a B2B: tap it on one act, then on the other. Each act in a B2B is
// still its own seen act, so each is credited.
// Typing offers acts you've entered on other events; a click, or arrow keys
// then Enter, adds one as you spelled it before. Enter alone adds what you typed.
const SeenActs: React.FC<{ seen: Seen[]; sets: Map<string, string>; past: string[]; onChange: (seen: SeenPatch) => void }> = ({
  seen,
  sets,
  past,
  onChange,
}) => {
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(-1);
  const [pairing, setPairing] = useState<string | null>(null);
  const matches = matchNames(draft, past, new Set(seen.map((s) => s.key)));
  const addNames = (names: string[]) => {
    if (names.length) onChange([...toPatch(seen), ...names.map((name) => ({ name, from: 'you' as const }))]);
    setDraft('');
    setActive(-1);
  };
  const add = () => addNames(draft.split(',').map((s) => s.trim()).filter(Boolean));
  const setRole = (key: string, role: Seen['role'] | null) =>
    onChange(toPatch(seen).map((s, i) => (seen[i].key === key ? { ...s, role, roleFrom: 'you' as const } : s)));
  const remove = (key: string) => onChange(toPatch(seen.filter((s) => s.key !== key)));
  const favourite = (key: string) =>
    onChange(toPatch(seen).map((s, i) => ({ ...s, favourite: seen[i].key === key && !seen[i].favourite })));
  const cycleSet = (key: string) =>
    onChange(toPatch(seen).map((s, i) => (seen[i].key === key ? { ...s, set: NEXT_SET[seen[i].set ?? 'none'] } : s)));
  const b2bTap = (s: Seen) => {
    if (pairing === s.key) return setPairing(null);
    if (pairing) {
      onChange(toPatch(pairB2b(seen, pairing, s.key)));
      return setPairing(null);
    }
    if (s.b2b?.length) return onChange(toPatch(leaveB2b(seen, s.key)));
    setPairing(s.key);
  };
  const pairingName = seen.find((s) => s.key === pairing)?.name;
  const chip = (s: Seen) => (
    <span
      key={s.key}
      className={`inline-flex items-center gap-1 rounded-full py-1 pl-2.5 pr-1.5 text-sm text-zinc-100 ${
        pairing === s.key ? 'bg-violet-700/50 ring-1 ring-violet-400' : 'bg-zinc-800'
      }`}
    >
      <button
        onClick={() => favourite(s.key)}
        aria-label={s.favourite ? `${s.name} is your favourite set` : `Mark ${s.name} as your favourite set`}
        title={s.favourite ? 'Favourite set of the night' : 'Mark as favourite set'}
        className={s.favourite ? 'text-rose-400' : 'text-zinc-600 hover:text-rose-300'}
      >
        <Heart className={`h-3 w-3 ${s.favourite ? 'fill-rose-400' : ''}`} />
      </button>
      {/* Tapping the name marks or unmarks Headliner, as your choice. */}
      <button
        onClick={() => setRole(s.key, s.role === 'headliner' ? null : 'headliner')}
        aria-label={s.role === 'headliner' ? `Unmark ${s.name} as headliner` : `Mark ${s.name} as headliner`}
        title={s.role === 'headliner' ? 'Headliner (tap to unmark)' : 'Tap to mark as headliner'}
        className="hover:text-amber-200"
      >
        {s.name}
      </button>
      {s.role === 'headliner' && <span className="text-[10px] uppercase text-amber-300/80">headliner</span>}
      {sets.get(s.key) && <span className="text-[10px] text-zinc-500">{sets.get(s.key)}</span>}
      <button
        onClick={() => cycleSet(s.key)}
        aria-label={s.set ? `${s.name}: ${SET_LABELS[s.set]}. Change` : `Mark ${s.name} as DJ set or live set`}
        title={s.set ? `${SET_LABELS[s.set]} (tap to change)` : 'DJ set or live set?'}
        className={`rounded px-1 text-[10px] uppercase ${s.set ? 'bg-sky-500/15 text-sky-300' : 'text-zinc-600 hover:text-zinc-300'}`}
      >
        {s.set === 'dj' ? 'DJ' : s.set === 'live' ? 'Live' : 'set'}
      </button>
      <button
        onClick={() => b2bTap(s)}
        aria-label={
          pairing && pairing !== s.key
            ? `B2B with ${pairingName}`
            : s.b2b?.length
              ? `Take ${s.name} out of the B2B`
              : `Pair ${s.name} B2B with another act`
        }
        title={pairing && pairing !== s.key ? `B2B with ${pairingName}` : s.b2b?.length ? 'Take out of the B2B' : 'B2B with another act'}
        className={s.b2b?.length || pairing === s.key ? 'text-violet-300' : 'text-zinc-600 hover:text-zinc-300'}
      >
        <Link2 className="h-3 w-3" />
      </button>
      <button
        onClick={() => setRole(s.key, s.role === 'support' ? null : 'support')}
        aria-label={s.role === 'support' ? `Move ${s.name} to Artist` : `Move ${s.name} to Supporting`}
        title={s.role === 'support' ? 'Move to Artist' : 'Move to Supporting'}
        className="text-zinc-500 hover:text-zinc-200"
      >
        {s.role === 'support' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      </button>
      <button onClick={() => remove(s.key)} aria-label={`Remove ${s.name}`} className="text-zinc-500 hover:text-zinc-200">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
  const artists = artistsOf(seen);
  const support = supportOf(seen);
  // A B2B shows as one slot: its acts side by side, joined by "b2b".
  const slot = (acts: Seen[]) =>
    acts.length === 1 ? (
      chip(acts[0])
    ) : (
      <span key={acts.map((a) => a.key).join('+')} className="inline-flex flex-wrap items-center gap-1 rounded-full border border-violet-500/30 p-0.5">
        {acts.map((a, i) => (
          <React.Fragment key={a.key}>
            {i > 0 && <span className="text-[10px] font-semibold uppercase text-violet-300/80">b2b</span>}
            {chip(a)}
          </React.Fragment>
        ))}
      </span>
    );
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-20 shrink-0 text-[11px] font-semibold text-zinc-500">Artist</span>
        {seenSlots(artists).map(slot)}
        {!artists.length && <span className="text-xs text-zinc-600">None yet</span>}
      </div>
      {support.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-20 shrink-0 text-[11px] font-semibold text-zinc-500">Supporting</span>
          {seenSlots(support).map(slot)}
        </div>
      )}
      {pairingName && (
        <p className="text-xs text-violet-300">
          Tap the link on the act {pairingName} played B2B with.{' '}
          <button onClick={() => setPairing(null)} className="text-zinc-400 hover:underline">
            Cancel
          </button>
        </p>
      )}
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && matches.length) {
            e.preventDefault();
            setActive((i) => (i + 1) % matches.length);
          } else if (e.key === 'ArrowUp' && matches.length) {
            e.preventDefault();
            setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
          } else if (e.key === 'Enter' && matches[active]) {
            e.preventDefault();
            addNames([matches[active]]);
          } else if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Escape') setDraft('');
        }}
        onBlur={add}
        placeholder={seen.length ? 'Add another' : 'Type a name and press Enter'}
        aria-label="Add an act you saw"
        className="w-full bg-transparent px-1.5 py-1 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
      />
      {matches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1" role="listbox" aria-label="Acts you've entered before">
          <span className="text-[11px] text-zinc-500">Seen before:</span>
          {matches.map((name, i) => (
            <button
              key={name}
              role="option"
              aria-selected={i === active}
              // mousedown, so the input's blur doesn't add the half-typed text first
              onMouseDown={(e) => {
                e.preventDefault();
                addNames([name]);
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                i === active ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-700 text-zinc-300 hover:border-violet-500'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// The weather on the event's days, with where it was read from; or a button
// to look it up once there is a past date and a city.
const Weather: React.FC<{ event: LoggedEvent; busy: boolean; note: string | null; onLookUp: () => void }> = ({ event, busy, note, onLookUp }) => {
  const w = event.weather;
  if (w) {
    return (
      <div className="space-y-0.5 text-xs">
        <p className="inline-flex items-center gap-1 text-zinc-300">
          <CloudSun className="h-3.5 w-3.5 text-zinc-500" /> Weather
        </p>
        <ul className="space-y-0.5 text-zinc-400">
          {w.days.map((d) => (
            <li key={d.date}>
              {w.days.length > 1 && <span className="text-zinc-500">{whenLabel({ startDate: d.date })}: </span>}
              {weatherLine(d) || 'No reading'}
            </li>
          ))}
        </ul>
        <a href={w.sourceUrl} target="_blank" rel="noreferrer" className="text-zinc-600 hover:text-violet-300">
          Open-Meteo archive, {w.place} <ExternalLink className="inline h-2.5 w-2.5" />
        </a>
      </div>
    );
  }
  if (!event.startDate || !event.city) return null;
  return (
    <div className="space-y-1">
      <button onClick={onLookUp} disabled={busy} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudSun className="h-3 w-3" />} Look up the weather
      </button>
      {note && <p className="text-xs text-zinc-500">{note}</p>}
    </div>
  );
};

function candidateLine(c: DetailCandidate): string {
  return [whenLabel(c), c.venue, c.city, c.country].filter(Boolean).join(' · ');
}

const JOB_STATUS: Record<LookupJob['status'], string> = {
  queued: 'Waiting to start',
  running: 'Looking through sources',
  waiting_quota: 'Waiting for capacity',
  needs_review: 'Ready to review',
  no_data: 'No source listed a lineup',
  confirmed: 'Confirmed',
  failed: 'Failed',
};

// A starting vocabulary for Format; your own past values come first.
const FORMAT_IDEAS = [
  'Club night',
  'Warehouse party',
  'Block party',
  'Day party',
  'Boat party',
  'Rave',
  'Residency',
  'Live set',
  'DJ set',
  'Listening party',
  'Livestream',
];

// Venues, cities and formats you've entered before, most used first.
function pastValues(events: LoggedEvent[], field: 'venue' | 'city' | 'format'): string[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const v = e[field]?.trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

// The city you gave every other time at this venue, if there is exactly one.
function cityForVenue(events: LoggedEvent[], venue: string): string | undefined {
  const cities = new Set(events.filter((e) => e.venue?.trim().toLowerCase() === venue.toLowerCase() && e.city).map((e) => e.city!));
  return cities.size === 1 ? [...cities][0] : undefined;
}

export const EventDetail: React.FC<EventDetailProps> = ({ event, events, onChange, onDeleted, onClose }) => {
  const [job, setJob] = useState<LookupJob | null>(null);
  const [edition, setEdition] = useState<Edition | null>(null);
  const [suggestions, setSuggestions] = useState<ArtistSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineupUrl, setLineupUrl] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [cityQuery, setCityQuery] = useState('');
  const [foundCities, setFoundCities] = useState<string[]>([]);

  useEffect(() => {
    if (cityQuery.trim().length < 3) return setFoundCities([]);
    const t = setTimeout(() => {
      eventsApi.cities(cityQuery).then(setFoundCities, () => setFoundCities([]));
    }, 300);
    return () => clearTimeout(t);
  }, [cityQuery]);

  const others = events.filter((e) => e.id !== event.id);
  const pastVenues = pastValues(others, 'venue');
  // Cities you gave before, as "Las Vegas, NV": picking one brings its state
  // and, when none is stored, its country.
  const pastPlaces = useMemo(() => {
    const out = new Map<string, Pick<LoggedEvent, 'city' | 'region' | 'country'>>();
    for (const e of others) {
      const label = cityWithRegion(e.city, e.region);
      if (label && !out.has(label)) out.set(label, { city: e.city, region: e.region, country: e.country });
    }
    return out;
  }, [events, event.id]);
  const pastCities = pastValues(others.map((e) => ({ ...e, city: cityWithRegion(e.city, e.region) })), 'city');
  const citySuggestions = [...new Set([...pastCities, ...foundCities])];
  const saveCity = (v: string) => {
    const typed = text(v);
    const past = typed ? pastPlaces.get(typed) : undefined;
    // A new city drops the old one's state; "City, ST" brings its own.
    if (past) return save({ city: past.city, region: past.region ?? null, ...(event.country || !past.country ? {} : { country: past.country }) });
    return save({ city: typed, region: null });
  };

  // The state and country the map service gives for your city, offered
  // under State when either is missing. Saved only when you tap it.
  const [placeGuess, setPlaceGuess] = useState<PlaceGuess | null>(null);
  useEffect(() => {
    setPlaceGuess(null);
    if (!event.city || (event.region && event.country)) return;
    let live = true;
    eventsApi.placeGuess({ city: event.city, region: event.region, country: event.country }).then(
      (r) => live && setPlaceGuess(r.guess),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [event.city, event.region, event.country]);
  const guessed = placeGuess ? placePatch(event, placeGuess) : null;
  const formatSuggestions = [...new Set([...pastValues(others, 'format'), ...FORMAT_IDEAS])];
  const pastArtists = useMemo(() => pastArtistNames(others), [events, event.id]);
  const pastCompanions = useMemo(() => pastCompanionNames(others), [events, event.id]);

  const load = useCallback(async () => {
    try {
      const data = await eventsApi.get(event.id);
      setJob(data.job);
      setEdition(data.edition);
      setSuggestions(data.suggestions ?? []);
      // Slower: parts of the name MusicBrainz knows as artists.
      eventsApi
        .nameArtists(event.id)
        .then((more) => setSuggestions((list) => [...list, ...more.filter((m) => !list.some((s) => s.key === m.key))]))
        .catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [event.id]);

  useEffect(() => {
    void load();
  }, [load, event.lineupJobId, event.editionId, event.seen.length, event.details.status]);

  useEffect(() => {
    if (!isActive(job?.status)) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [job, load]);

  const run = async (label: string, fn: () => Promise<LoggedEvent | void>) => {
    setBusy(label);
    setError(null);
    try {
      const updated = await fn();
      if (updated) onChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const save = (patch: EventPatch) => run('save', () => eventsApi.update(event.id, patch));
  const [weatherNote, setWeatherNote] = useState<string | null>(null);
  const lookUpWeather = () =>
    run('weather', async () => {
      const r = await eventsApi.weather(event.id);
      setWeatherNote(r.note ?? null);
      return r.event;
    });
  const text = (v: string) => (v.trim() ? v.trim() : null);

  const seenKeys = new Set(event.seen.map((s) => s.key));
  const lineupActs = (edition?.performances ?? []).filter((p) => p.status !== 'cancelled');
  // Stage and set time per act, from timed sources (Clashfinder). Days you
  // went narrow it when you gave them.
  const multiDay = Boolean(event.endDate && event.endDate !== event.startDate);
  const sets = new Map<string, string>();
  for (const p of [
    ...(job?.candidate?.performers ?? []).map((c) => ({ key: c.key, sources: c.sources })),
    ...lineupActs.map((c) => ({ key: c.artistKey, sources: c.sources })),
  ]) {
    const all = actSets(p);
    const onDays = all.filter((s) => s.day && event.daysAttended.includes(s.day));
    const shown = onDays.length ? onDays : all;
    if (shown.length) sets.set(p.key, shown.map((s) => setLabel(s, multiDay)).join('; '));
  }
  const days = datesBetween(event.startDate, event.endDate);
  const details = event.details;

  // Fields where the confirmed suggestion differs from what's saved; "Look
  // again" never replaces a field on its own, so these are offered instead.
  const confirmed = details.status === 'matched' || details.status === 'resolved' ? details.candidates[0] : undefined;
  const offer = (field: EventField) => {
    const v = confirmed?.[field];
    // Sources write "Las Vegas, NV": the same as your city and state.
    const yours = field === 'city' ? cityWithRegion(event.city, event.region) : event[field];
    if (!confirmed || !v || v === yours || (field === 'city' && v === event.city)) return undefined;
    const src = confirmed.sources.find((s) => s.fields.includes(field));
    return {
      value: field === 'endDate' ? whenLabel({ startDate: v }) ?? v : v,
      from: src ? SOURCE_LABELS[src.sourceType] : 'a source',
      onUse: () => void run('save', () => eventsApi.pick(event.id, confirmed.id, [field])),
    };
  };
  const confirmations = dateConfirmations(event);
  const scale = eventScale(event, edition ? lineupFacts(edition) : undefined);
  const worked = eventScale({ ...event, kind: undefined }, edition ? lineupFacts(edition) : undefined);
  const offered = suggestions.filter((s) => !seenKeys.has(s.key));
  const roleName = (role?: Seen['role']) => (role === 'support' ? 'Supporting' : 'Artist');

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl space-y-6 overflow-y-auto border-l border-zinc-900 bg-zinc-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <Field label="Event" value={event.name} onSave={(v) => save({ name: v })} className="flex-1" />
          <button onClick={onClose} className="mt-6 text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {event.input && event.input !== event.name && <p className="-mt-4 text-xs text-zinc-600">You typed: “{event.input}”</p>}
        <div className="-mt-2 space-y-1">
          <div className="flex items-end gap-2">
            <Field
              label="Series"
              value={event.series}
              placeholder="Festival or tour it's one year of, e.g. EDC Las Vegas"
              suggestions={seriesOffers(event, others)}
              onSave={(v) => save({ series: text(v), ...(text(v) ? {} : { weekend: null }) })}
              className="flex-1"
            />
            {event.series && (
              <label className="space-y-1">
                <span className="text-[11px] font-semibold text-zinc-400">Weekend</span>
                <select
                  className={input}
                  value={event.weekend ?? ''}
                  onChange={(e) => save({ weekend: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">{weekendFromName(event.name) ? `Not set (name says ${weekendFromName(event.name)})` : 'Only one'}</option>
                  {[1, 2, 3, 4].map((w) => (
                    <option key={w} value={w}>
                      Weekend {w}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {event.series && (
            <p className="text-[11px] text-zinc-500">
              Shows as “{eventTitle(event)}”
              {(() => {
                const n = seriesList(events).find((g) => g.name === event.series)?.events.length ?? 1;
                return n > 1 ? ` · ${n} editions in your log` : '';
              })()}
            </p>
          )}
        </div>
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}

        {/* Stage 1: when and where */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className={sectionTitle}>When and where</h3>
            <button
              onClick={() => run('research', () => eventsApi.research(event.id))}
              disabled={busy === 'research'}
              className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
            >
              {busy === 'research' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Look again
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" type="date" value={event.startDate} source={event.sources.startDate} onSave={(v) => save({ startDate: text(v) })} />
            {/* Shows the start date until you change it, so the picker opens on the
                right month; stored only when it differs (a single-day event has no last day). */}
            <Field
              label="Last day"
              type="date"
              value={event.endDate ?? event.startDate}
              min={event.startDate}
              source={event.endDate ? event.sources.endDate : undefined}
              offer={offer('endDate')}
              onSave={(v) => save({ endDate: v && v !== event.startDate ? v : null })}
            />
            {!event.startDate && (
              <Field label="Year, if that's all you know" type="number" value={event.year} placeholder="2024" onSave={(v) => save({ year: v ? Number(v) : null })} />
            )}
            <Field
              label="Venue"
              value={event.venue}
              source={event.sources.venue}
              suggestions={pastVenues}
              offer={offer('venue')}
              onSave={(v) => {
                const venue = text(v);
                const city = venue && !event.city ? cityForVenue(others, venue) : undefined;
                void save(city ? { venue, city } : { venue });
              }}
            />
            <Field
              label="City"
              value={event.city}
              placeholder="City"
              source={event.sources.city}
              suggestions={citySuggestions}
              offer={offer('city')}
              onType={setCityQuery}
              onSave={(v) => void saveCity(v)}
            />
            <Field
              label="State"
              value={event.region}
              placeholder="NV, or the region"
              source={event.sources.region}
              offer={
                offer('region') ??
                (guessed && placeGuess
                  ? { value: placeGuess.label, from: placeGuess.places > 1 ? 'the map (the biggest by that name)' : 'the map', onUse: () => void save(guessed) }
                  : undefined)
              }
              onSave={(v) => save({ region: text(v) })}
            />
            <Field label="Country" value={event.country} source={event.sources.country} offer={offer('country')} onSave={(v) => save({ country: text(v) })} />
            <label className="space-y-1">
              <span className="flex items-center justify-between gap-2 text-[11px] font-semibold text-zinc-400">
                Type
                <span className="font-normal text-zinc-500">{scale.by === 'rule' && scale.kind ? scale.reason : ''}</span>
              </span>
              <select
                className={input}
                value={event.kind ?? ''}
                onChange={(e) => save({ kind: (e.target.value || null) as EventPatch['kind'] })}
              >
                <option value="">
                  {worked.kind ? `${KIND_LABELS[worked.kind]} (worked out)` : 'Not known yet'}
                </option>
                <option value="concert">Concert</option>
                <option value="festival">Festival</option>
              </select>
            </label>
          </div>

          {details.status === 'choose' && (
            <div className="space-y-2 rounded-xl border border-violet-500/30 bg-violet-950/20 p-3">
              <p className="text-sm text-violet-200">
                {event.startDate ? 'Sources give a different date. Is it one of these?' : 'Is it one of these?'}
              </p>
              {details.candidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => run('pick', () => eventsApi.pick(event.id, c.id))}
                  className="flex w-full items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-left hover:border-violet-500"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-100">{candidateLine(c) || c.name}</span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {c.name && `${c.name} · `}
                      {c.sources.length > 1 ? `${c.sources.length} sources: ` : ''}
                      {[...new Set(c.sources.map((s) => SOURCE_LABELS[s.sourceType]))].join(', ')}
                    </span>
                  </span>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
                </button>
              ))}
              <button onClick={() => run('pick', () => eventsApi.pick(event.id))} className="text-xs text-zinc-400 hover:underline">
                None of these
              </button>
            </div>
          )}
          {confirmations.length > 0 && (
            <div className="space-y-1 text-xs">
              <p className="inline-flex items-center gap-1 text-emerald-300/90">
                <Check className="h-3.5 w-3.5" /> Date confirmed by {confirmations.length} source{confirmations.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-0.5 text-zinc-500">
                {confirmations.map((s, i) => (
                  <li key={i} className="truncate">
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-violet-300">
                      {SOURCE_LABELS[s.sourceType]}
                      {s.quote ? `: “${s.quote}”` : ''} <ExternalLink className="inline h-2.5 w-2.5" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {details.status === 'none' && <p className="text-xs text-zinc-500">No listing found. It's saved as you typed it.</p>}
          {details.status === 'needs_date' && <p className="text-xs text-amber-300/90">Add when it was (a year is enough), then look again.</p>}
          {details.status === 'off' && <p className="text-xs text-zinc-500">No event source is set up, so details are as you typed them.</p>}
          <Weather event={event} busy={busy === 'weather'} note={weatherNote} onLookUp={lookUpWeather} />
        </section>

        {/* Who you saw */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Who you saw</h3>
          <SeenActs seen={event.seen} sets={sets} past={pastArtists} onChange={(seen) => save({ seen })} />
          {offered.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-zinc-500">From the event name:</span>
              {offered.map((s) => (
                <button
                  key={s.key}
                  onClick={() =>
                    save({ seen: [...toPatch(event.seen), { name: s.name, from: 'you', role: s.role, roleFrom: s.role ? 'you' : undefined }] })
                  }
                  title={
                    s.sourceType === 'user'
                      ? 'You saw them at another event'
                      : s.sourceType === 'musicbrainz'
                        ? 'An artist of this name on MusicBrainz'
                        : `Listed by ${SOURCE_LABELS[s.sourceType]}`
                  }
                  className="inline-flex items-center gap-1 rounded-full border border-violet-500/50 px-2.5 py-1 text-violet-200 hover:bg-violet-950/40"
                >
                  <Plus className="h-3 w-3" /> {s.name} as {roleName(s.role)}?
                </button>
              ))}
            </div>
          )}
          {lineupActs.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-zinc-500">From the lineup, tap to mark who you saw:</p>
              <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                {lineupActs.map((p) => {
                  const on = seenKeys.has(p.artistKey);
                  return (
                    <button
                      key={p.artistKey}
                      onClick={() =>
                        save({
                          seen: on
                            ? toPatch(event.seen.filter((s) => s.key !== p.artistKey))
                            : [...toPatch(event.seen), { name: p.name, from: 'lineup', role: p.billing, roleFrom: p.billing ? 'lineup' : undefined }],
                        })
                      }
                      title={[p.billing && `Billed as ${p.billing}`, sets.get(p.artistKey)].filter(Boolean).join(' · ') || undefined}
                      className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                    >
                      {p.name}
                      {p.billing === 'support' && <span className="ml-1 text-[10px] text-zinc-500">support</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* Stage 2: the lineup */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Full lineup</h3>
          {!job && !edition && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">
                Optional. The app looks for who played in Clashfinder, the promoter's page and ticketing listings, cites every act, and never guesses.
              </p>
              <input className={input} value={lineupUrl} onChange={(e) => setLineupUrl(e.target.value)} placeholder="Lineup page, if you know one (optional)" />
            </div>
          )}
          {edition && (
            <p className="text-sm text-zinc-300">
              {lineupActs.length} acts confirmed, each with a source.
            </p>
          )}
          {job && !edition && (
            <div className="space-y-2 rounded-xl border border-zinc-800 p-3">
              <div className="flex items-center gap-2 text-sm text-zinc-200">
                {isActive(job.status) && <Loader2 className="h-4 w-4 animate-spin text-violet-300" />}
                {/* Between steps a job is briefly queued again; it is still looking. */}
                {job.status === 'queued' && job.stage !== 'collect' && !job.nextAttemptAt ? JOB_STATUS.running : JOB_STATUS[job.status]}
                {job.status === 'needs_review' && ` · ${job.candidate?.performers.length ?? 0} acts`}
              </div>
              {job.status === 'waiting_quota' && (
                <p className="text-xs text-amber-200/90">
                  {job.waitingReason} It continues on its own
                  {job.nextAttemptAt ? ` after ${new Date(job.nextAttemptAt).toLocaleString()}` : ''}; what was found so far is kept.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {(job.status === 'needs_review' || job.status === 'no_data') && (
                  <button onClick={() => setReviewing(true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">
                    {job.status === 'no_data' ? 'Enter acts by hand' : 'Review lineup'}
                  </button>
                )}
                {(job.status === 'waiting_quota' || job.status === 'failed') && (
                  <button
                    onClick={() =>
                      run('retry', async () => {
                        await lineupApi.retry(job.id);
                        setTimeout(() => void load(), 500);
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900"
                  >
                    <RefreshCw className="h-3 w-3" /> Try now
                  </button>
                )}
                <button onClick={() => setShowLog((s) => !s)} className="text-xs text-zinc-500 hover:text-zinc-300">
                  {showLog ? 'Hide' : 'Show'} what it did
                </button>
              </div>
              {showLog && (
                <ol className="max-h-60 space-y-1 overflow-y-auto font-mono text-[11px] text-zinc-500">
                  {job.log.map((entry, i) => (
                    <li key={i}>{entry.message}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {(!job || edition || job.status === 'no_data' || job.status === 'failed') && !isActive(job?.status) && (
            <button
              onClick={() => run('lineup', async () => (await eventsApi.findLineup(event.id, lineupUrl || undefined)).event)}
              disabled={busy === 'lineup' || !(event.year || event.startDate)}
              title={event.year || event.startDate ? undefined : 'Add when it was first'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/50 px-3 py-1.5 text-sm text-violet-200 hover:bg-violet-950/40 disabled:opacity-40"
            >
              {busy === 'lineup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {job ? 'Look up the lineup again' : 'Find who played'}
            </button>
          )}
        </section>

        {/* Your details */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Your notes</h3>
          <Field
            label="Format"
            value={event.format}
            placeholder="Club night, warehouse party, block party…"
            suggestions={formatSuggestions}
            onSave={(v) => save({ format: text(v) })}
          />
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Went with</span>
            <ChipInput items={event.companions} placeholder="Add a name" past={pastCompanions} label="Add who you went with" onChange={(companions) => save({ companions })} />
          </label>
          {days.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
              <span className="font-semibold text-zinc-400">Days you went:</span>
              {days.map((d) => {
                const on = event.daysAttended.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => save({ daysAttended: on ? event.daysAttended.filter((x) => x !== d) : [...event.daysAttended, d].sort() })}
                    className={`rounded-full border px-2.5 py-1 ${on ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400'}`}
                  >
                    {new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-zinc-400">Rating</span>
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => save({ rating: event.rating === n ? null : n })} aria-label={`${n} stars`}>
                    <Star className={`h-5 w-5 ${event.rating && n <= event.rating ? 'fill-amber-400 text-amber-400' : 'text-zinc-700'}`} />
                  </button>
                ))}
              </div>
            </div>
            <Field
              label="Ticket price"
              type="number"
              value={event.ticketPrice}
              onSave={(v) => save({ ticketPrice: v ? Number(v) : null })}
              className="w-32"
            />
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Notes</span>
            <textarea
              className={input}
              rows={3}
              defaultValue={event.notes ?? ''}
              onBlur={(e) => e.target.value !== (event.notes ?? '') && save({ notes: text(e.target.value) })}
            />
          </label>
        </section>

        <div className="flex items-center justify-between border-t border-zinc-900 pt-4">
          <button
            onClick={() =>
              window.confirm(`Delete "${eventTitle(event)}" from your log?`) &&
              run('delete', async () => {
                await eventsApi.remove(event.id);
                onDeleted();
              })
            }
            className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete event
          </button>
          {busy === 'save' && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
        </div>
      </div>

      {reviewing && job && (
        <LineupReview
          job={job}
          event={event}
          onClose={() => setReviewing(false)}
          onSaved={(updated) => {
            setReviewing(false);
            onChange(updated);
            void load();
          }}
        />
      )}
    </div>
  );
};
