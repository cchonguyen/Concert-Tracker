import { Dialog } from './ui/Dialog';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CloudSun, ExternalLink, Heart, Loader2, MapPin, Plus, RefreshCw, Search, Star, Type, X } from 'lucide-react';
import {
  ArtistSuggestion,
  eventsApi,
  lineupApi,
  LineupFacts,
  LineupSummary,
  LoggedEvent,
  LookupJob,
  EventPatch,
  PlaceGuess,
  SOURCE_LABELS,
} from '../services/lineupApi';
import { formatsOf, whenLabel } from '../services/format';
import { toSeenInput } from '../server/events/seen';
import { canFindLineup, cityOf, Gap, gapCounts, GAPS, hasGap, placePatch } from '../services/table';
import { regionCode } from '../server/events/regions';
import { EventTitle } from './EventTitle';
import { SuggestInput } from './SuggestInput';

interface FillGapsProps {
  events: LoggedEvent[]; // the rows the Table shows
  all: LoggedEvent[]; // your whole log, for suggestions
  lineups: Record<string, LineupSummary>;
  editions: Record<string, LineupFacts>;
  onChanged: (event: LoggedEvent) => void;
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}

const GAP_LABELS: Record<Gap, string> = {
  date: 'Date',
  venue: 'Venue',
  city: 'City',
  place: 'State & country',
  type: 'Type',
  seen: 'Who you saw',
  favourite: 'Favourite set',
  review: 'Lineup to review',
  format: 'Format',
  companions: 'Went with',
  rating: 'Rating',
  price: 'Price',
  weather: 'Weather',
};

// Matches MAX_BULK_LOOKUPS on the server.
const LOOKUPS_PER_REQUEST = 5;

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';

function byCount(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const seenPatch = (e: LoggedEvent) => toSeenInput(e.seen);

// Why an act is offered from the event's name.
const offeredBy = (s: ArtistSuggestion) =>
  s.sourceType === 'user'
    ? 'You saw them at another event'
    : s.sourceType === 'musicbrainz'
      ? 'An artist of this name on MusicBrainz'
      : `Listed by ${SOURCE_LABELS[s.sourceType]}`;

// Acts named in one event's title, as chips you tick; "Add" saves the ticked
// ones as acts you saw, with any role the title gives.
const TitleArtistsRow: React.FC<{
  offered: ArtistSuggestion[];
  ticked: Set<string>;
  onToggle: (key: string) => void;
  onAdd: () => void;
}> = ({ offered, ticked, onToggle, onAdd }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    <span className="text-[11px] text-zinc-400">From the title:</span>
    {offered.map((s) => {
      const on = ticked.has(s.key);
      return (
        <button
          key={s.key}
          role="checkbox"
          aria-checked={on}
          onClick={() => onToggle(s.key)}
          title={offeredBy(s)}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
            on ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {on ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          {s.name}
          {s.role === 'support' && <span className="text-[10px] text-zinc-400">support</span>}
          {s.sourceType === 'musicbrainz' && <span className="text-[10px] text-zinc-400">MusicBrainz</span>}
        </button>
      );
    })}
    <button
      onClick={onAdd}
      disabled={!ticked.size}
      className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
    >
      Add {ticked.size || ''}
    </button>
  </div>
);

// One gap on one event: type the value and press Enter. Saving goes through
// the usual event edit, so every value is sourced as yours.
const GapEditor: React.FC<{
  event: LoggedEvent;
  gap: Gap;
  suggestions: string[];
  onSave: (patch: EventPatch) => Promise<void>;
}> = ({ event, gap, suggestions, onSave }) => {
  const [draft, setDraft] = useState('');
  const submit = (patch: EventPatch | null) => {
    if (!patch) return;
    setDraft('');
    void onSave(patch);
  };
  const fromDraft = (): EventPatch | null => {
    const v = draft.trim();
    if (!v) return null;
    switch (gap) {
      case 'date':
        return /^\d{4}$/.test(v) ? { year: Number(v) } : { startDate: v };
      case 'venue':
        return { venue: v };
      case 'city':
        return { city: v };
      case 'place': {
        // "NV, United States", or one of them: a US or Canadian state code
        // or name is the state, anything else the country.
        const [first, ...rest] = v.split(',').map((p) => p.trim());
        const country = rest.join(', ');
        if (!first) return null;
        if (country) return { region: first, country };
        return regionCode(first) || event.country ? { region: first } : { country: first };
      }
      case 'format':
        return { format: v };
      case 'seen':
        return { seen: [...seenPatch(event), ...list(v).map((name) => ({ name, from: 'you' as const }))] };
      case 'companions':
        return { companions: [...event.companions, ...list(v)] };
      case 'price':
        return Number.isFinite(Number(v)) ? { ticketPrice: Number(v) } : null;
      default:
        return null;
    }
  };

  if (gap === 'type') {
    return (
      <div className="flex gap-1.5">
        {(['concert', 'festival'] as const).map((k) => (
          <button key={k} onClick={() => submit({ kind: k })} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:border-violet-500">
            {k === 'concert' ? 'Concert' : 'Festival'}
          </button>
        ))}
      </div>
    );
  }
  if (gap === 'favourite') {
    return (
      <div className="flex flex-wrap gap-1.5">
        {event.seen.map((s, i) => (
          <button
            key={s.key}
            onClick={() => submit({ seen: seenPatch(event).map((p, j) => ({ ...p, favourite: i === j })) })}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-amber-400"
          >
            <Heart className="h-3 w-3" /> {s.name}
          </button>
        ))}
      </div>
    );
  }
  if (gap === 'weather') return null;
  if (gap === 'rating') {
    return (
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => submit({ rating: n })} aria-label={`${n} stars`}>
            <Star className="h-5 w-5 text-zinc-400 hover:fill-amber-400 hover:text-amber-400" />
          </button>
        ))}
      </div>
    );
  }
  const placeholder: Partial<Record<Gap, string>> = {
    date: 'YYYY-MM-DD, or just the year',
    seen: 'Names, separated by commas',
    companions: 'Names, separated by commas',
    city: 'City, ST',
    place: 'State, Country',
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(fromDraft());
    }
  };
  return (
    <>
      {gap === 'price' ? (
        <input
          className={control}
          type="number"
          aria-label={GAP_LABELS[gap]}
          value={draft}
          placeholder={placeholder[gap] ?? GAP_LABELS[gap]}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => submit(fromDraft())}
        />
      ) : (
        <SuggestInput
          className={control}
          aria-label={GAP_LABELS[gap]}
          value={draft}
          placeholder={placeholder[gap] ?? GAP_LABELS[gap]}
          suggestions={suggestions}
          onPick={setDraft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => submit(fromDraft())}
        />
      )}
    </>
  );
};

// A lineup the lookup found, accepted in one tap: every act the sources agree
// on is kept (low-evidence ones are left out, not rejected), and acts you had
// already ticked stay ticked. "Open" shows the full review.
const ReviewRow: React.FC<{ event: LoggedEvent; onDone: (e: LoggedEvent) => void; onOpen: () => void }> = ({ event, onDone, onOpen }) => {
  const [job, setJob] = useState<LookupJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    eventsApi.get(event.id).then((d) => setJob(d.job), (err) => setError(String(err)));
  }, [event.id]);
  const acts = job?.candidate?.performers ?? [];
  const kept = acts.filter((p) => !p.flagged);
  const seen = new Set(event.seen.map((s) => s.key));
  const accept = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const { event: updated } = await lineupApi.confirm(job.id, {
        performers: kept.map((p) => ({ key: p.key, name: p.name, accepted: true, seen: seen.has(p.key) })),
      });
      if (updated) onDone(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  if (!job) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
  const head = kept.filter((p) => p.billing !== 'support');
  const support = kept.filter((p) => p.billing === 'support');
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-zinc-300">
        {head.slice(0, 8).map((p) => p.name).join(', ')}
        {head.length > 8 && ` +${head.length - 8} more`}
        {support.length > 0 && <span className="text-zinc-400"> · supporting: {support.map((p) => p.name).join(', ')}</span>}
      </p>
      {acts.length > kept.length && (
        <p className="text-[11px] text-amber-300/80">{acts.length - kept.length} low-evidence act(s) left out; open it to look at them.</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={accept}
          disabled={busy || !kept.length}
          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Accept {kept.length} act{kept.length === 1 ? '' : 's'}
        </button>
        <button onClick={onOpen} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-900">
          <ExternalLink className="h-3 w-3" /> Open
        </button>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
};

// Fill gaps: pick something that's missing, then type it in row by row. Also
// starts details research or lineup lookups for many events at once. Nothing
// is filled without you; lookups only propose.
export const FillGaps: React.FC<FillGapsProps> = ({ events, all, lineups, editions, onChanged, onRefresh, onOpen, onClose }) => {
  const counts = useMemo(() => gapCounts(events, lineups, editions), [events, lineups, editions]);
  const [gap, setGap] = useState<Gap>(() => GAPS.find((g) => counts[g] > 0) ?? 'date');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = events.filter((e) => hasGap(e, gap, lineups[e.id], editions[e.id]));
  const suggestions = useMemo(() => {
    switch (gap) {
      case 'venue':
        return byCount(all.flatMap((e) => (e.venue ? [e.venue] : [])));
      case 'city':
        return byCount(all.flatMap((e) => (e.city ? [cityOf(e)!] : [])));
      case 'format':
        return byCount(all.flatMap((e) => formatsOf(e.format)));
      case 'seen':
        return byCount(all.flatMap((e) => e.seen.map((s) => s.name)));
      case 'companions':
        return byCount(all.flatMap((e) => e.companions));
      default:
        return [];
    }
  }, [gap, all]);

  const save = async (id: string, patch: EventPatch) => {
    setError(null);
    try {
      onChanged(await eventsApi.update(id, patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Stage 1 research for each row missing a date or place, one at a time.
  const researchable = rows.filter((e) => e.year || e.startDate);
  const research = async () => {
    setBusy('research');
    setError(null);
    let done = 0;
    for (const e of researchable) {
      setNote(`Looking up details: ${done + 1} of ${researchable.length}…`);
      try {
        onChanged(await eventsApi.research(e.id));
      } catch {
        // One failure doesn't stop the rest; the event keeps what it had.
      }
      done += 1;
    }
    setNote(`Looked up ${done} event${done === 1 ? '' : 's'}. Confirmed dates and places are filled in; anything else waits for your pick on the event.`);
    setBusy(null);
  };

  // Weather for each row, one at a time; rows it can't place say why.
  const [weatherNotes, setWeatherNotes] = useState<Record<string, string>>({});
  const lookUpWeather = async () => {
    setBusy('weather');
    setError(null);
    let found = 0;
    for (const [i, e] of rows.entries()) {
      setNote(`Looking up weather: ${i + 1} of ${rows.length}…`);
      try {
        const r = await eventsApi.weather(e.id);
        if (r.event.weather) {
          found += 1;
          onChanged(r.event);
        } else if (r.note) setWeatherNotes((n) => ({ ...n, [e.id]: r.note! }));
      } catch (err) {
        setWeatherNotes((n) => ({ ...n, [e.id]: err instanceof Error ? err.message : String(err) }));
      }
    }
    setNote(`Found the weather for ${found} of ${rows.length}.`);
    setBusy(null);
  };

  // The state and country for each row's city, from the geocoder. Shown as
  // offers; nothing is saved until you tap Use or Use all.
  const [guesses, setGuesses] = useState<Record<string, PlaceGuess>>({});
  const [placeNotes, setPlaceNotes] = useState<Record<string, string>>({});
  const lookUpPlaces = async () => {
    setBusy('places');
    setError(null);
    let found = 0;
    for (const [i, e] of rows.entries()) {
      setNote(`Looking up states and countries: ${i + 1} of ${rows.length}…`);
      try {
        const r = await eventsApi.placeGuess({ city: e.city!, region: e.region, country: e.country });
        if (r.guess && placePatch(e, r.guess)) {
          found += 1;
          setGuesses((g) => ({ ...g, [e.id]: r.guess! }));
        } else if (r.note) setPlaceNotes((n) => ({ ...n, [e.id]: r.note! }));
      } catch (err) {
        setPlaceNotes((n) => ({ ...n, [e.id]: err instanceof Error ? err.message : String(err) }));
      }
    }
    setNote(`Found ${found} of ${rows.length}. Check them, then use them; the rest say why below.`);
    setBusy(null);
  };
  const usePlace = async (e: LoggedEvent) => {
    const g = guesses[e.id];
    const patch = g && placePatch(e, g);
    if (patch) await save(e.id, patch);
  };
  const guessed = gap === 'place' ? rows.filter((e) => guesses[e.id] && placePatch(e, guesses[e.id])) : [];
  const useAllPlaces = async () => {
    setBusy('places-use');
    setError(null);
    const list = guessed;
    for (const [i, e] of list.entries()) {
      setNote(`Saving: ${i + 1} of ${list.length}…`);
      await usePlace(e);
    }
    setNote(`Added the state and country to ${list.length} event${list.length === 1 ? '' : 's'}.`);
    setBusy(null);
  };

  // Artists from titles, for every row missing who you saw. Suggestions from
  // what's stored come at once; MusicBrainz is asked per event on request.
  // Ticked by default: acts a source lists for the event or you saw before.
  // MusicBrainz name matches wait for your tick. Nothing saves without "Add".
  const [offered, setOffered] = useState<Record<string, ArtistSuggestion[]>>({});
  const [ticked, setTicked] = useState<Record<string, Set<string>>>({});
  const [askedMb, setAskedMb] = useState<Set<string>>(new Set());
  const stopMb = useRef(false);
  const fetched = useRef(new Set<string>());
  const offer = (id: string, list: ArtistSuggestion[]) => {
    if (!list.length) return;
    setOffered((o) => {
      const prev = o[id] ?? [];
      return { ...o, [id]: [...prev, ...list.filter((s) => !prev.some((p) => p.key === s.key))] };
    });
    setTicked((t) => {
      const next = new Set(t[id] ?? []);
      for (const s of list) if (s.sourceType !== 'musicbrainz') next.add(s.key);
      return { ...t, [id]: next };
    });
  };
  const seenIds = gap === 'seen' ? rows.map((e) => e.id).join(',') : '';
  useEffect(() => {
    if (!seenIds) return;
    const ids = seenIds.split(',').filter((id) => !fetched.current.has(id)).slice(0, 500);
    if (!ids.length) return;
    ids.forEach((id) => fetched.current.add(id));
    eventsApi.titleArtists(ids).then(
      (found) => Object.entries(found).forEach(([id, list]) => offer(id, list)),
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [seenIds]);
  const toggle = (id: string, key: string) =>
    setTicked((t) => {
      const next = new Set(t[id] ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...t, [id]: next };
    });
  const pickedFor = (e: LoggedEvent) => (offered[e.id] ?? []).filter((s) => ticked[e.id]?.has(s.key));
  const addFromTitle = async (e: LoggedEvent) => {
    const picked = pickedFor(e);
    if (!picked.length) return;
    await save(e.id, {
      seen: [...seenPatch(e), ...picked.map((s) => ({ name: s.name, from: 'you' as const, role: s.role, roleFrom: s.role ? ('you' as const) : undefined }))],
    });
  };
  const withPicks = gap === 'seen' ? rows.filter((e) => pickedFor(e).length) : [];
  const addAllFromTitles = async () => {
    setBusy('title-add');
    setError(null);
    const list = withPicks;
    for (const [i, e] of list.entries()) {
      setNote(`Adding artists: ${i + 1} of ${list.length}…`);
      await addFromTitle(e);
    }
    setNote(`Added artists to ${list.length} event${list.length === 1 ? '' : 's'}.`);
    setBusy(null);
  };
  const mbRows = gap === 'seen' ? rows.filter((e) => !askedMb.has(e.id)) : [];
  const checkMusicBrainz = async () => {
    setBusy('mb');
    setError(null);
    stopMb.current = false;
    let found = 0;
    const list = mbRows;
    for (const [i, e] of list.entries()) {
      if (stopMb.current) break;
      setNote(`Checking MusicBrainz: ${i + 1} of ${list.length} (about a second per name)…`);
      try {
        const more = await eventsApi.nameArtists(e.id);
        if (more.length) found += 1;
        offer(e.id, more);
      } catch {
        // One failure doesn't stop the rest.
      }
      setAskedMb((s) => new Set(s).add(e.id));
    }
    setNote(`MusicBrainz knew an artist in ${found} more title${found === 1 ? '' : 's'}. Tick the ones that are right.`);
    setBusy(null);
  };
  const tickAll = () =>
    setTicked((t) => {
      const next = { ...t };
      for (const e of rows) next[e.id] = new Set((offered[e.id] ?? []).map((s) => s.key));
      return next;
    });

  const lineupRows = rows.filter((e) => canFindLineup(e, lineups[e.id])).slice(0, 50);
  const findLineups = async () => {
    setBusy('lineups');
    setError(null);
    try {
      // A few per request: each queued lookup costs several database calls,
      // and a Worker request may make only 50.
      let started = 0;
      for (let i = 0; i < lineupRows.length; i += LOOKUPS_PER_REQUEST) {
        setNote(`Queueing lineup lookups: ${Math.min(i + LOOKUPS_PER_REQUEST, lineupRows.length)} of ${lineupRows.length}…`);
        const r = await eventsApi.findLineups(lineupRows.slice(i, i + LOOKUPS_PER_REQUEST).map((e) => e.id));
        started += r.started.length;
      }
      setNote(
        `Queued ${started} lineup lookup${started === 1 ? '' : 's'}. They run one at a time in the background; found lineups show up under "Lineup to review".`,
      );
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog title="Fill gaps" onClose={onClose} panelClassName="h-full w-full max-w-2xl space-y-4 overflow-y-auto border-l border-zinc-900 bg-zinc-950 p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-50">Fill gaps</h2>
          <p className="text-xs text-zinc-400">
            Across the {events.length} event{events.length === 1 ? '' : 's'} the Table shows. Pick what's missing, type it in, press Enter.
          </p>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {GAPS.map((g) => (
          <button
            key={g}
            onClick={() => {
              setGap(g);
              setNote(null);
            }}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              gap === g ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {GAP_LABELS[g]} <span className="text-zinc-400">{counts[g]}</span>
          </button>
        ))}
      </div>

      {(gap === 'date' || gap === 'venue' || gap === 'city') && researchable.length > 0 && (
        <button
          onClick={research}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40"
        >
          {busy === 'research' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Look up details for these {researchable.length}
        </button>
      )}
      {(gap === 'seen' || gap === 'type') && lineupRows.length > 0 && (
        <button
          onClick={findLineups}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/50 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-950/40 disabled:opacity-40"
        >
          {busy === 'lineups' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          Find lineups for {lineupRows.length === 50 ? 'the first 50' : `these ${lineupRows.length}`}
        </button>
      )}
      {gap === 'seen' && rows.length > 0 && (
        <div className="space-y-2 rounded-xl border border-zinc-800 p-3">
          <p className="text-xs text-zinc-400">
            <Type className="mr-1 inline h-3.5 w-3.5" />
            Artists named in the event titles are ticked below when a listing, lineup or one of your other events backs them. Untick any
            that are wrong, then add.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={addAllFromTitles}
              disabled={busy !== null || !withPicks.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {busy === 'title-add' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Add ticked artists to {withPicks.length} event{withPicks.length === 1 ? '' : 's'}
            </button>
            {busy === 'mb' ? (
              <button
                onClick={() => (stopMb.current = true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Stop checking
              </button>
            ) : (
              mbRows.length > 0 && (
                <button
                  onClick={checkMusicBrainz}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40"
                >
                  <Search className="h-3.5 w-3.5" /> Check MusicBrainz for names in these {mbRows.length} titles
                </button>
              )
            )}
            {rows.some((e) => (offered[e.id]?.length ?? 0) > (ticked[e.id]?.size ?? 0)) && (
              <button onClick={tickAll} disabled={busy !== null} className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline disabled:opacity-40">
                Tick all
              </button>
            )}
          </div>
        </div>
      )}
      {gap === 'weather' && rows.length > 0 && (
        <button
          onClick={lookUpWeather}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40"
        >
          {busy === 'weather' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudSun className="h-3.5 w-3.5" />}
          Look up weather for these {rows.length}
        </button>
      )}
      {gap === 'place' && rows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={lookUpPlaces}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40"
          >
            {busy === 'places' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
            Look up from the city for these {rows.length}
          </button>
          {guessed.length > 0 && (
            <button
              onClick={useAllPlaces}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {busy === 'places-use' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Use all {guessed.length}
            </button>
          )}
        </div>
      )}
      {note && <p className="text-xs text-zinc-400">{note}</p>}
      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-400">Nothing missing here.</p>
      ) : (
        <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900">
          {rows.map((e) => (
            <li key={e.id} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <button onClick={() => onOpen(e.id)} className="truncate text-left text-sm font-medium text-zinc-100 hover:underline">
                  <EventTitle event={e} />
                </button>
                <span className="shrink-0 text-xs text-zinc-400">
                  {[whenLabel(e) ?? 'Date unknown', e.venue, gap === 'place' ? [cityOf(e), e.country].filter(Boolean).join(', ') : undefined]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              {gap === 'review' ? (
                <ReviewRow
                  event={e}
                  onOpen={() => onOpen(e.id)}
                  onDone={(updated) => {
                    onChanged(updated);
                    onRefresh();
                  }}
                />
              ) : (
                <GapEditor event={e} gap={gap} suggestions={suggestions} onSave={(patch) => save(e.id, patch)} />
              )}
              {gap === 'seen' && offered[e.id]?.length ? (
                <TitleArtistsRow
                  offered={offered[e.id]}
                  ticked={ticked[e.id] ?? new Set()}
                  onToggle={(key) => toggle(e.id, key)}
                  onAdd={() => void addFromTitle(e)}
                />
              ) : null}
              {gap === 'weather' && weatherNotes[e.id] && <p className="text-[11px] text-amber-300/80">{weatherNotes[e.id]}</p>}
              {gap === 'place' && guesses[e.id] && placePatch(e, guesses[e.id]) && (
                <button
                  onClick={() => void usePlace(e)}
                  className="inline-flex items-center gap-1 rounded-full border border-violet-500/50 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-950/40"
                >
                  <Check className="h-3 w-3" /> Use {guesses[e.id].label}
                  {guesses[e.id].places > 1 && <span className="text-[10px] text-zinc-400">biggest of {guesses[e.id].places} by that name</span>}
                </button>
              )}
              {gap === 'place' && placeNotes[e.id] && <p className="text-[11px] text-amber-300/80">{placeNotes[e.id]}</p>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
};
