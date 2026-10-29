import { useVault } from './VaultContext';
import { noteView } from '../services/vaultSession';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, CloudSun, ExternalLink, FolderCog, Heart, History, Loader2, Plus, RefreshCw, Search, Star, Trash2, X } from 'lucide-react';
import {
  ArtistSuggestion,
  DetailCandidate,
  Edition,
  EventField,
  EventPatch,
  eventsApi,
  isActive,
  lineupApi,
  LineupStatus,
  LoggedEvent,
  LookupJob,
  PlaceGuess,
  FIELD_SOURCE_LABELS,
  SOURCE_LABELS,
} from '../services/lineupApi';
import { artistsOf, dateConfirmations, datesBetween, formatsOf, joinFormats, matchNames, pastArtistNames, pastCompanionNames, supportOf, weatherLine, whenLabel } from '../services/format';
import { actSets, setLabel } from '../server/events/sets';
import { eventScale, KIND_LABELS, lineupFacts } from '../server/events/scale';
import { LineupReview } from './LineupReview';
import { norm } from '../services/listImport';
import { leaveB2b, pairB2b, seenSlots, SET_LABELS, setSolo, SlotAct, slotId, toSeenInput } from '../server/events/seen';
import { eventTitle, seriesList, seriesOffers, weekendFromName } from '../services/series';
import { SuggestInput } from './SuggestInput';
import { SeenGenres } from './SeenGenres';
import { EventTitle } from './EventTitle';
import { hasGap, placePatch } from '../services/table';
import { dateText, thingsLeft } from '../services/poster';
import { PosterHeader, ThingsLeft } from './PosterHeader';
import { cityWithRegion } from '../server/events/regions';
import { attendanceOf, lastDay } from '../server/events/attendance';
import type { EditionPerformance } from '../server/lineup/types';
import type { ManageTarget } from './ManageView';
import { DetailShell, type DetailRow } from './ui/DetailShell';
import { Confirm } from './ui/Confirm';
import { useToast } from './ui/Toast';
import { Switch } from './ui/Switch';
import { Sheet } from './ui/Sheet';
import { LineupProgress } from './LineupProgress';
import { CheckDetails, type Suggestion } from './CheckDetails';
import { Pill } from './ui/Pill';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { Segmented } from './ui/Segmented';
import { SaveStatus } from './ui/SaveStatus';
import { beginSave, emptyTrack, failSave, hintVisit, succeedSave, takeFailed, type SaveTrack } from '../services/saveStatus';

interface EventDetailProps {
  event: LoggedEvent;
  // Your whole log, for venue and city suggestions.
  events: LoggedEvent[];
  onChange: (event: LoggedEvent) => void;
  onDeleted: () => void;
  onClose: () => void;
  // The list this event sits in (split view and the header's previous, next and next-with-gaps), and how to open another row.
  rows: DetailRow[];
  onOpen: (id: string) => void;
  // Open a name's record in the Manage tab, to change it on every event.
  onManage?: (target: ManageTarget) => void;
  onOpenHistory?: (eventId: string) => void; // Opens the Log filtered to this show.
}

// The names on this event that have a record, for "Edit everywhere".
function manageLinks(event: LoggedEvent): Array<{ label: string; target: ManageTarget }> {
  const refs = event.refs;
  if (!refs) return [];
  const out: Array<{ label: string; target: ManageTarget }> = [];
  if (event.venue && refs.venueId) out.push({ label: event.venue, target: { kind: 'venue', id: refs.venueId } });
  if (event.city && refs.placeId) out.push({ label: event.city, target: { kind: 'place', id: refs.placeId } });
  if (event.series && refs.seriesId) out.push({ label: event.series, target: { kind: 'series', id: refs.seriesId } });
  event.companions.forEach((name, i) => {
    const id = refs.companionIds[i];
    if (id) out.push({ label: name, target: { kind: 'person', id } });
  });
  return out;
}

// Notes: plain text on a single-owner install; encrypted in the browser when
// the member's vault is on, and read-only while it is locked.
const NotesField: React.FC<{ stored?: string | null; onSave: (v: string | null) => void }> = ({ stored, onSave }) => {
  const vault = useVault();
  const [shown, setShown] = useState<string | null>(stored ? null : '');
  useEffect(() => {
    let live = true;
    vault.readNote(stored ?? undefined).then((v) => live && setShown(v), () => live && setShown(null));
    return () => {
      live = false;
    };
  }, [stored, vault.status]);
  const view = noteView(shown);
  const locked = !view.editable;
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold text-zinc-400">
        Notes {locked && <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-amber-300">{view.badge}</span>}
      </span>
      <textarea
        key={`${stored ?? ''}|${locked}`}
        className={input}
        rows={3}
        readOnly={locked}
        placeholder={locked ? 'Vault locked: unlock it in Your account to read or edit.' : undefined}
        defaultValue={shown ?? ''}
        onBlur={async (e) => {
          const v = e.target.value.trim();
          if (locked || v === (shown ?? '')) return;
          if (!v) return onSave(null);
          onSave(vault.status === 'unlocked' ? await vault.encryptNote(v) : v);
        }}
      />
    </label>
  );
};

const input =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-400';

// Typing saves 500 ms after the last key, so a sheet closed at once (iOS Safari) still gets its last value through the blur flush.
const SAVE_DELAY_MS = 500;
// Counts how many times an event has been opened on this device, for the "Changes save as you go" hint.
const HINT_KEY = 'liveArchive.saveHint';
// The fields a save has just written; each one flashes for a moment.
const FlashContext = React.createContext<string[]>([]);

// A text field that saves when you leave it, and 500 ms after you stop typing.
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
  // The event field this saves, so a save of it flashes.
  field?: keyof EventPatch;
}> = ({ label, value, type = 'text', placeholder, source, onSave, onType, suggestions, offer, min, className, field }) => {
  const flashing = React.useContext(FlashContext);
  const flash = field !== undefined && flashing.includes(field);
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const pending = useRef<number | null>(null);
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };
  // Saves the draft now if it differs from the stored value, and cancels any timed save.
  const flush = () => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = null;
    const now = latest.current;
    if (now.draft !== (now.value === undefined ? '' : String(now.value))) now.onSave(now.draft);
  };
  const scheduleSave = () => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };
  // Leaving the field with a save still waiting saves it.
  useEffect(() => () => flush(), []);
  return (
    <label className={`-m-0.5 space-y-1 rounded-lg p-0.5 transition-shadow motion-reduce:transition-none ${flash ? 'ring-1 ring-emerald-500/60' : ''} ${className ?? ''}`}>
      <span className="flex items-center justify-between gap-2 text-[11px] font-semibold text-zinc-400">
        <span className="inline-flex items-center gap-1">
          {label}
          {flash && <Check className="h-3 w-3 text-emerald-300" aria-label="Saved" />}
        </span>
        {source && source.sourceType !== 'user' && (
          <a
            href={source.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title={source.quote ? `“${source.quote}”` : undefined}
            className="inline-flex items-center gap-0.5 font-normal text-zinc-400 hover:text-violet-300"
          >
            {source.sourceType === 'venue' ? 'from' : 'via'} {FIELD_SOURCE_LABELS[source.sourceType]} <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </span>
      {suggestions ? (
        <SuggestInput
          className={input}
          value={draft}
          placeholder={placeholder}
          suggestions={suggestions}
          onPick={(v) => {
            setDraft(v);
            onType?.(v);
            scheduleSave();
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            onType?.(e.target.value);
            scheduleSave();
          }}
          onBlur={flush}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <input
          className={input}
          type={type}
          value={draft}
          min={min}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            onType?.(e.target.value);
            scheduleSave();
          }}
          onBlur={flush}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {offer && (
        <button type="button" onClick={offer.onUse} className="block w-full truncate text-left text-[11px] text-violet-300 hover:underline">
          Use “{offer.value}” from {offer.from}
        </button>
      )}
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
            <button onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${item}`} className="text-zinc-400 hover:text-zinc-200">
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
          <span className="text-[11px] text-zinc-400">Before:</span>
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

// Which days of a multi-day event you went. No days stored means every day,
// so each day starts ticked and you untick the ones you missed. Ticking every
// day again stores none; the last ticked day can't be unticked.
const DaysWent: React.FC<{ days: string[]; attended: string[]; onChange: (days: string[]) => void }> = ({ days, attended, onChange }) => {
  const picked = attended.filter((d) => days.includes(d));
  const went = picked.length ? picked : days;
  const toggle = (d: string) => {
    const next = went.includes(d) ? went.filter((x) => x !== d) : [...went, d].sort();
    onChange(next.length === days.length ? [] : next);
  };
  return (
    <div className="col-span-2 flex flex-wrap items-center gap-2 text-xs text-zinc-300">
      <span className="font-semibold text-zinc-400">Days you went{went.length === days.length ? ' (all)' : ''}:</span>
      {days.map((d) => {
        const on = went.includes(d);
        const last = on && went.length === 1;
        return (
          <button
            key={d}
            onClick={() => toggle(d)}
            disabled={last}
            title={last ? 'You went at least one day' : on ? 'Tap if you missed this day' : 'Tap if you went this day'}
            aria-pressed={on}
            className={`rounded-full border px-2.5 py-1 ${on ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400 line-through'}`}
          >
            {new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })}
          </button>
        );
      })}
    </div>
  );
};

type Seen = LoggedEvent['seen'][number];
type SeenPatch = NonNullable<EventPatch['seen']>;

const toPatch = (seen: Seen[]): SeenPatch => toSeenInput(seen);

// Whether you went, for an event added before it happened. Until you say,
// it is left out of Stats, Artists and the Map. Once it is over the app
// asks; "Yes" counts it at once, then offers the acts you planned to see
// and the lineup to tick, and the days you went. Nothing is ticked for you
// that wasn't already on the event.
type Offered = { key: string; name: string; from: 'you' | 'lineup'; role?: Seen['role'] };
const WentCard: React.FC<{
  event: LoggedEvent;
  lineupActs: EditionPerformance[];
  days: string[];
  canReview: boolean;
  onSave: (patch: EventPatch) => void;
  onReview: () => void;
}> = ({ event, lineupActs, days, canReview, onSave, onReview }) => {
  const [offered, setOffered] = useState<Offered[] | null>(null);
  const state = attendanceOf(event, new Date().toISOString().slice(0, 10));
  const seenKeys = new Set(event.seen.map((s) => s.key));
  const box = 'space-y-2 rounded-xl border p-3 text-sm';

  if (offered) {
    const toggle = (o: Offered) =>
      onSave({
        seen: seenKeys.has(o.key)
          ? toPatch(event.seen.filter((s) => s.key !== o.key))
          : [...toPatch(event.seen), { name: o.name, from: o.from, role: o.role, roleFrom: o.role ? o.from : undefined }],
      });
    return (
      <div className={`${box} border-emerald-500/30 bg-emerald-950/20`}>
        <p className="inline-flex items-center gap-1 font-semibold text-emerald-200">
          <Check className="h-4 w-4" /> Counted. Who did you see?
        </p>
        {offered.length > 0 && (
          <>
            <p className="text-xs text-zinc-400">
              {event.seen.length || offered.some((o) => o.from === 'you') ? 'Untick anyone you missed' : 'Tap who you saw'}
              {lineupActs.length ? ', and tap anyone else from the lineup.' : '.'}
            </p>
            <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
              {offered.map((o) => {
                const on = seenKeys.has(o.key);
                return (
                  <button
                    key={o.key}
                    onClick={() => toggle(o)}
                    aria-pressed={on}
                    className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-violet-500 bg-violet-600/30 text-violet-100' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                  >
                    {o.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {days.length > 1 && <DaysWent days={days} attended={event.daysAttended} onChange={(daysAttended) => onSave({ daysAttended })} />}
        <div className="flex flex-wrap items-center gap-3">
          {canReview && <Button variant="primary" onClick={onReview}>Review the lineup</Button>}
          <Button onClick={() => setOffered(null)}>Done</Button>
          <span className="text-xs text-zinc-400">Add anyone else under Who you saw.</span>
        </div>
      </div>
    );
  }

  if (state === 'upcoming') {
    const last = lastDay(event);
    return (
      <p className={`${box} border-sky-500/30 bg-sky-950/20 text-sky-200`}>
        Upcoming. It isn't counted in Stats, Artists or the Map yet
        {last ? `; after ${whenLabel({ startDate: last }) ?? last} the app asks whether you went.` : '.'}
      </p>
    );
  }

  if (state === 'missed') {
    return (
      <div className={`${box} flex flex-wrap items-center justify-between gap-2 border-zinc-800 text-zinc-400`}>
        <span>You didn't go, so it isn't counted.</span>
        <button onClick={() => onSave({ attendance: null })} className="text-xs text-zinc-300 hover:underline">
          I did go
        </button>
      </div>
    );
  }

  if (state !== 'confirm') return null;
  const went = () => {
    onSave({ attendance: null });
    const acts: Offered[] = [
      ...event.seen.map((s) => ({ key: s.key, name: s.name, from: s.from, role: s.role })),
      ...lineupActs.filter((p) => !seenKeys.has(p.artistKey)).map((p) => ({ key: p.artistKey, name: p.name, from: 'lineup' as const, role: p.billing })),
    ];
    if (acts.length || days.length > 1 || canReview) setOffered(acts);
  };
  return (
    <div className={`${box} border-violet-500/40 bg-violet-950/30`}>
      <p className="font-semibold text-violet-100">Did you go?</p>
      <p className="text-xs text-zinc-400">It's over, and it stays out of Stats, Artists and the Map until you say.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={went}>Yes, I went</Button>
        <Button onClick={() => onSave({ attendance: 'missed' })}>No, I didn't go</Button>
      </div>
    </div>
  );
};

// Who you saw. Each act is a chip that shows only what is stored about it; a tap opens its editor in a Sheet.
// Typing offers acts you've entered on other events; a click, or arrow keys then Enter, adds one as you spelled it
// before. Enter alone adds what you typed. Typing a B2B act's name again adds its solo set.
const SeenActs: React.FC<{ seen: Seen[]; sets: Map<string, string>; past: string[]; onChange: (seen: SeenPatch) => void }> = ({
  seen,
  sets,
  past,
  onChange,
}) => {
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(-1);
  const [editing, setEditing] = useState<string | null>(null);
  // An act in a B2B without a solo set can be typed again, for its solo set.
  const canSolo = (s: Seen) => Boolean(s.b2b?.length) && !s.solo;
  const matches = matchNames(draft, past, new Set(seen.filter((s) => !canSolo(s)).map((s) => s.key)));
  const addNames = (names: string[]) => {
    const soloKeys = new Set(seen.filter(canSolo).map((s) => s.key));
    const solos = names.filter((n) => soloKeys.has(norm(n)));
    const fresh = names.filter((n) => !soloKeys.has(norm(n)));
    let next = seen;
    for (const n of solos) next = setSolo(next, norm(n), true);
    if (names.length) onChange([...toPatch(next), ...fresh.map((name) => ({ name, from: 'you' as const }))]);
    setDraft('');
    setActive(-1);
  };
  const add = () => addNames(draft.split(',').map((s) => s.trim()).filter(Boolean));
  const chip = (s: SlotAct<Seen>) => (
    <button
      key={s.asSolo ? `${s.key}:solo` : s.key}
      type="button"
      onClick={() => setEditing(s.key)}
      title="Edit this act"
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-zinc-800 px-3 text-sm text-zinc-100 hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 sm:min-h-8"
    >
      {s.favourite && <Heart aria-label="Favourite set of the night" className="h-3 w-3 fill-rose-400 text-rose-400" />}
      <span>{s.name}</span>
      {s.role === 'headliner' && <Pill tone="accent">Headliner</Pill>}
      {s.asSolo && <Pill>Solo</Pill>}
      {s.set && <Pill>{s.set === 'dj' ? 'DJ' : 'Live'}</Pill>}
      {sets.get(s.key) && <span className="text-xs text-zinc-400">{sets.get(s.key)}</span>}
    </button>
  );
  const artists = artistsOf(seen);
  const support = supportOf(seen);
  // A B2B shows as one slot: its acts side by side, joined by "b2b".
  const slot = (acts: Array<SlotAct<Seen>>) =>
    acts.length === 1 ? (
      chip(acts[0])
    ) : (
      <span key={slotId(acts)} className="inline-flex flex-wrap items-center gap-1 rounded-full border border-violet-500/30 p-0.5">
        {acts.map((a, i) => (
          <React.Fragment key={a.key}>
            {i > 0 && <span className="text-[10px] font-semibold uppercase text-violet-300/80">b2b</span>}
            {chip(a)}
          </React.Fragment>
        ))}
      </span>
    );
  const editingAct = seen.find((s) => s.key === editing);
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-20 shrink-0 text-[11px] font-semibold text-zinc-400">Artist</span>
        {seenSlots(artists).map(slot)}
        {!artists.length && <span className="text-xs text-zinc-400">None yet</span>}
      </div>
      {support.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-20 shrink-0 text-[11px] font-semibold text-zinc-400">Supporting</span>
          {seenSlots(support).map(slot)}
        </div>
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
          <span className="text-[11px] text-zinc-400">Seen before:</span>
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
      <Sheet open={Boolean(editingAct)} title={editingAct?.name ?? ''} onClose={() => setEditing(null)}>
        {editingAct && (
          <ActEditor
            seen={seen}
            act={editingAct}
            time={sets.get(editingAct.key)}
            onChange={onChange}
            onRemoved={() => setEditing(null)}
          />
        )}
      </Sheet>
    </div>
  );
};

// One act's settings, in the Sheet: billing, set, B2B partners, the solo set, and the favourite. Each change saves at
// once, through the same helpers the chip used (setSolo, pairB2b, leaveB2b, toSeenInput).
const ActEditor: React.FC<{
  seen: Seen[];
  act: Seen;
  time?: string;
  onChange: (seen: SeenPatch) => void;
  onRemoved: () => void;
}> = ({ seen, act, time, onChange, onRemoved }) => {
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const key = act.key;
  const patchAct = (change: Partial<SeenPatch[number]>) => onChange(toPatch(seen).map((s, i) => (seen[i].key === key ? { ...s, ...change } : s)));
  const partners = seen.filter((s) => act.b2b?.includes(s.key));
  const free = seen.filter((s) => s.key !== key && !act.b2b?.includes(s.key));
  const favouriteElsewhere = seen.find((s) => s.favourite && s.key !== key);
  const billingHelp = !act.role
    ? 'No role stated, so it counts as Artist.'
    : act.roleFrom === 'you'
      ? 'Your choice.'
      : act.roleFrom === 'lineup'
        ? 'From the lineup. Changing it here makes it your choice.'
        : 'Set on this act. Changing it here makes it your choice.';
  return (
    <div className="space-y-5">
      {time && <p className="text-sm text-zinc-300">Set time: {time}</p>}
      <section className="space-y-2">
        <h4 className={sectionTitle}>Billing</h4>
        <Segmented<'headliner' | 'artist' | 'support'>
          label="Billing"
          value={act.role ?? 'artist'}
          onChange={(v) => patchAct({ role: v === 'artist' ? null : v, roleFrom: 'you' })}
          options={[
            { value: 'headliner', label: 'Headliner' },
            { value: 'artist', label: 'Artist' },
            { value: 'support', label: 'Supporting' },
          ]}
        />
        <p className="text-xs text-zinc-400">{billingHelp}</p>
      </section>
      <section className="space-y-2">
        <h4 className={sectionTitle}>Set</h4>
        <Segmented<'dj' | 'live' | 'none'>
          label="Set"
          value={act.set ?? 'none'}
          onChange={(v) => patchAct({ set: v === 'none' ? null : v })}
          options={[
            { value: 'dj', label: 'DJ set' },
            { value: 'live', label: 'Live set' },
            { value: 'none', label: 'Not sure' },
          ]}
        />
      </section>
      <section className="space-y-2">
        <h4 className={sectionTitle}>Played B2B with</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {partners.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1 rounded-full bg-zinc-800 py-1 pl-2.5 pr-1 text-sm text-zinc-100">
              {p.name}
              <button
                type="button"
                onClick={() => onChange(toPatch(leaveB2b(seen, p.key)))}
                aria-label={`Take ${p.name} out of the B2B`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:text-zinc-200"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {!partners.length && <span className="text-xs text-zinc-400">No one yet.</span>}
          {free.length > 0 && (
            <Button onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
              Pick an act {picking ? '▴' : '▾'}
            </Button>
          )}
        </div>
        {picking && (
          <div className="flex flex-wrap gap-1.5">
            {free.map((o) => (
              <Button
                key={o.key}
                onClick={() => {
                  onChange(toPatch(pairB2b(seen, key, o.key)));
                  setPicking(false);
                }}
              >
                {o.name}
              </Button>
            ))}
          </div>
        )}
        <p className="text-xs text-zinc-400">Both still count as seen, each with full credit.</p>
      </section>
      {partners.length > 0 && (
        <Switch checked={Boolean(act.solo)} onChange={(v) => onChange(toPatch(setSolo(seen, key, v)))} label="Also played a solo set" />
      )}
      <Switch
        checked={Boolean(act.favourite)}
        onChange={(v) => onChange(toPatch(seen).map((s, i) => ({ ...s, favourite: seen[i].key === key ? v : v ? false : s.favourite })))}
        label="Favourite set of the night"
        helper={favouriteElsewhere && !act.favourite ? `Only one per event. Turning this on moves it from ${favouriteElsewhere.name}.` : 'Only one per event.'}
      />
      <Button
        variant="danger"
        className="w-full"
        onClick={() => {
          const before = seen;
          onChange(toPatch(seen.filter((s) => s.key !== key)));
          onRemoved();
          toast({ message: `Removed ${act.name}`, action: { label: 'Undo', onClick: () => onChange(toPatch(before)) } });
        }}
      >
        Remove from who you saw
      </Button>
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
          <CloudSun className="h-3.5 w-3.5 text-zinc-400" /> Weather
        </p>
        <ul className="space-y-0.5 text-zinc-400">
          {w.days.map((d) => (
            <li key={d.date}>
              {w.days.length > 1 && <span className="text-zinc-400">{whenLabel({ startDate: d.date })}: </span>}
              {weatherLine(d) || 'No reading'}
            </li>
          ))}
        </ul>
        <a href={w.sourceUrl} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-violet-300">
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
      {note && <p className="text-xs text-zinc-400">{note}</p>}
    </div>
  );
};

function candidateLine(c: DetailCandidate): string {
  return [whenLabel(c), c.venue, c.city, c.country].filter(Boolean).join(' · ');
}

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

// Venues and cities you've entered before, most used first.
function pastValues(events: LoggedEvent[], field: 'venue' | 'city'): string[] {
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

export const EventDetail: React.FC<EventDetailProps> = ({ event, events, onChange, onDeleted, onClose, rows, onOpen, onManage, onOpenHistory }) => {
  const [job, setJob] = useState<LookupJob | null>(null);
  const [edition, setEdition] = useState<Edition | null>(null);
  const [suggestions, setSuggestions] = useState<ArtistSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineupUrl, setLineupUrl] = useState('');
  // Whether Gemini is set up and how much of today's budget is left, for
  // "Look again with Gemini".
  const [lineupStatus, setLineupStatus] = useState<LineupStatus | null>(null);
  useEffect(() => {
    lineupApi.status().then(setLineupStatus, () => setLineupStatus(null));
  }, [event.details.checkedAt]);
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
  const formatSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of others) for (const v of formatsOf(e.format)) counts.set(v, (counts.get(v) ?? 0) + 1);
    const past = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
    return [...new Set([...past, ...FORMAT_IDEAS])];
  }, [events, event.id]);
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
  // Saves are tracked for the status line. A failed patch is kept so Try again can resend it.
  const [track, setTrack] = useState<SaveTrack<EventPatch>>(() => emptyTrack<EventPatch>());
  const trackRef = useRef(track);
  const pendingSaves = useRef(new Set<Promise<void>>());
  const [flashing, setFlashing] = useState<string[]>([]);
  const flashTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);
  const [hint] = useState(() => {
    try {
      const visit = hintVisit(window.localStorage.getItem(HINT_KEY));
      window.localStorage.setItem(HINT_KEY, String(visit.next));
      return visit.show;
    } catch {
      return false;
    }
  });
  const update = (fn: (t: SaveTrack<EventPatch>) => SaveTrack<EventPatch>) => {
    trackRef.current = fn(trackRef.current);
    setTrack(trackRef.current);
  };
  const flash = (keys: string[]) => {
    setFlashing(keys);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashing([]), 1000);
  };
  const sendPatch = (patch: EventPatch) => {
    update(beginSave);
    const sent = eventsApi.update(event.id, patch).then(
      (updated) => {
        onChange(updated);
        update((t) => succeedSave(t, Date.now()));
        flash(Object.keys(patch));
      },
      () => update((t) => failSave(t, patch)),
    );
    pendingSaves.current.add(sent);
    void sent.finally(() => pendingSaves.current.delete(sent));
  };
  const save = (patch: EventPatch) => sendPatch(patch);
  const retrySaves = () => {
    const { track: rest, patches } = takeFailed(trackRef.current);
    update(() => rest);
    patches.forEach((patch) => sendPatch(patch));
  };
  // Closing first blurs the field being typed in, so its save starts and is waited for. A failed save keeps the detail open.
  const requestClose = async () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    await Promise.all([...pendingSaves.current]);
    if (trackRef.current.failed.length > 0) return;
    onClose();
  };
  // Moving to another event waits for saves in flight, as closing does, and stays here when one failed.
  const goTo = async (id: string) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    await Promise.all([...pendingSaves.current]);
    if (trackRef.current.failed.length > 0) return;
    onOpen(id);
  };
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
      from: src ? FIELD_SOURCE_LABELS[src.sourceType] : 'a source',
      onUse: () => void run('pick', () => eventsApi.pick(event.id, confirmed.id, [field])),
    };
  };
  // The found values that differ from yours, one card each on Check details; Use saves it through the same pick.
  const checkOffers: Suggestion[] = [
    { field: 'endDate' as const, label: 'Last day' },
    { field: 'venue' as const, label: 'Venue' },
    { field: 'city' as const, label: 'City' },
    { field: 'region' as const, label: 'State' },
    { field: 'country' as const, label: 'Country' },
  ].flatMap(({ field, label }) => {
    const o = offer(field);
    if (!o) return [];
    const yours = field === 'city' ? cityWithRegion(event.city, event.region) : field === 'endDate' ? (event.endDate ?? event.startDate) : event[field];
    return [{ key: field, label, yours: yours ? String(yours) : 'Not set', value: o.value, from: o.from, onUse: o.onUse }];
  });
  const confirmations = dateConfirmations(event);
  const scale = eventScale(event, edition ? lineupFacts(edition) : undefined);
  const worked = eventScale({ ...event, kind: undefined }, edition ? lineupFacts(edition) : undefined);
  const offered = suggestions.filter((s) => !seenKeys.has(s.key));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const toast = useToast();
  const roleName = (role?: Seen['role']) => (role === 'support' ? 'Supporting' : 'Artist');

  const state = attendanceOf(event, new Date().toISOString().slice(0, 10));
  // While the lineup review is open, Escape and an outside press do not close the panel behind it.
  return (
    <DetailShell
      title={eventTitle(event)}
      rows={rows}
      openId={event.id}
      closeDisabled={reviewing}
      onGo={(id) => void goTo(id)}
      onClose={() => void requestClose()}
    >
      <FlashContext.Provider value={flashing}>
        <SaveStatus track={track} onRetry={retrySaves} hint={hint} />
        <PosterHeader
          title={eventTitle(event)}
          dateText={dateText(event)}
          event={event}
          state={state}
          seen={event.seen}
          cited={edition ? edition.performances.filter((p) => p.status !== 'cancelled').map((p) => p.artistKey) : []}
        />
        <ThingsLeft gaps={thingsLeft(event, (e, g) => hasGap(e, g, undefined, edition ? lineupFacts(edition) : undefined))} />
        <div className="flex items-start gap-3">
          <Field label="Event" field="name" value={event.name} onSave={(v) => save({ name: v })} className="flex-1" />
        </div>
        {event.input && event.input !== event.name && <p className="-mt-4 text-xs text-zinc-400">You typed: “{event.input}”</p>}
        <div className="-mt-2 space-y-1">
          <div className="flex items-end gap-2">
            <Field
              label="Series"
              field="series"
              value={event.series}
              placeholder="Festival or tour it's one year of, e.g. EDC Las Vegas"
              suggestions={seriesOffers(event, others)}
              onSave={(v) => save({ series: text(v), ...(text(v) ? {} : { weekend: null }) })}
              className="flex-1"
            />
            {event.series && (
              <div className="space-y-1">
                <span className="block text-[11px] font-semibold text-zinc-400">Weekend</span>
                <Segmented<string>
                  label="Weekend"
                  value={event.weekend ? String(event.weekend) : ''}
                  onChange={(v) => save({ weekend: v ? Number(v) : null })}
                  options={[
                    { value: '', label: weekendFromName(event.name) ? `Not set (name says ${weekendFromName(event.name)})` : 'Only one' },
                    ...[1, 2, 3, 4].map((w) => ({ value: String(w), label: `Weekend ${w}` })),
                  ]}
                />
              </div>
            )}
          </div>
          {(event.series || eventTitle(event) !== event.name) && (
            <p className="text-[11px] text-zinc-400">
              Shows as “<EventTitle event={event} />”
              {(() => {
                const n = seriesList(events).find((g) => g.name === event.series)?.events.length ?? 1;
                return n > 1 ? ` · ${n} editions in your log` : '';
              })()}
            </p>
          )}
        </div>
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}
        <WentCard
          event={event}
          lineupActs={lineupActs}
          days={days}
          canReview={Boolean(job && job.status === 'needs_review' && !edition)}
          onSave={(patch) => void save(patch)}
          onReview={() => setReviewing(true)}
        />

        {/* Stage 1: when and where */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>When and where</h3>
          <CheckDetails
            busy={busy === 'research'}
            geminiBusy={busy === 'research-gemini'}
            checkedAt={details.checkedAt}
            status={details.status}
            candidates={details.candidates}
            notes={details.notes}
            lineupStatus={lineupStatus}
            suggestions={checkOffers}
            onCheck={() => void run('research', () => eventsApi.research(event.id))}
            onGemini={() => void run('research-gemini', () => eventsApi.research(event.id, true))}
            onPick={(id: string) => void run('pick', () => eventsApi.pick(event.id, id))}
            onNone={() => void run('pick', () => eventsApi.pick(event.id))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" field="startDate" type="date" value={event.startDate} source={event.sources.startDate} onSave={(v) => save({ startDate: text(v) })} />
            {/* Shows the start date until you change it, so the picker opens on the
                right month; stored only when it differs (a single-day event has no last day). */}
            <Field
              label="Last day"
              field="endDate"
              type="date"
              value={event.endDate ?? event.startDate}
              min={event.startDate}
              source={event.endDate ? event.sources.endDate : undefined}
              
              onSave={(v) => save({ endDate: v && v !== event.startDate ? v : null })}
            />
            {days.length > 1 && (
              <DaysWent days={days} attended={event.daysAttended} onChange={(daysAttended) => save({ daysAttended })} />
            )}
            {!event.startDate && (
              <Field label="Year, if that's all you know" field="year" type="number" value={event.year} placeholder="2024" onSave={(v) => save({ year: v ? Number(v) : null })} />
            )}
            <Field
              label="Venue"
              field="venue"
              value={event.venue}
              source={event.sources.venue}
              suggestions={pastVenues}
              onSave={(v) => {
                const venue = text(v);
                const city = venue && !event.city ? cityForVenue(others, venue) : undefined;
                void save(city ? { venue, city } : { venue });
              }}
            />
            <Field
              label="City"
              field="city"
              value={event.city}
              placeholder="City"
              source={event.sources.city}
              suggestions={citySuggestions}
              onType={setCityQuery}
              onSave={(v) => void saveCity(v)}
            />
            <Field
              label="State"
              field="region"
              value={event.region}
              placeholder="NV, or the region"
              source={event.sources.region}
              offer={
                (guessed && placeGuess
                  ? { value: placeGuess.label, from: placeGuess.places > 1 ? 'the map (the biggest by that name)' : 'the map', onUse: () => void save(guessed) }
                  : undefined)
              }
              onSave={(v) => save({ region: text(v) })}
            />
            <Field label="Country" field="country" value={event.country} source={event.sources.country} onSave={(v) => save({ country: text(v) })} />
            <div className="col-span-2 space-y-1">
              <span className="flex items-center justify-between gap-2 text-[11px] font-semibold text-zinc-400">
                Type
                <span className="font-normal text-zinc-400">{scale.by === 'rule' && scale.kind ? scale.reason : ''}</span>
              </span>
              <Segmented<string>
                label="Type"
                value={event.kind ?? ''}
                onChange={(v) => save({ kind: (v || null) as EventPatch['kind'] })}
                options={[
                  { value: '', label: worked.kind ? `${KIND_LABELS[worked.kind]} (worked out)` : 'Not known yet' },
                  { value: 'concert', label: 'Concert' },
                  { value: 'festival', label: 'Festival' },
                ]}
              />
            </div>
          </div>

          {confirmations.length > 0 && (
            <div className="space-y-1 text-xs">
              <p className="inline-flex items-center gap-1 text-emerald-300/90">
                <Check className="h-3.5 w-3.5" /> Date confirmed by {confirmations.length} source{confirmations.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-0.5 text-zinc-400">
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
          {details.status === 'none' && <p className="text-xs text-zinc-400">No listing found. It's saved as you typed it.</p>}
          {details.status === 'needs_date' && <p className="text-xs text-amber-300/90">Add when it was (a year is enough), then look again.</p>}
          {details.status === 'off' && <p className="text-xs text-zinc-400">No event source is set up, so details are as you typed them.</p>}
          <Weather event={event} busy={busy === 'weather'} note={weatherNote} onLookUp={lookUpWeather} />
        </section>

        {/* Who you saw */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Who you saw</h3>
          <SeenActs seen={event.seen} sets={sets} past={pastArtists} onChange={(seen) => save({ seen })} />
          <SeenGenres event={event} />
          {offered.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-zinc-400">From the event name:</span>
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
              <p className="text-[11px] text-zinc-400">From the lineup, tap to mark who you saw:</p>
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
                      {p.billing === 'support' && <span className="ml-1 text-[10px] text-zinc-400">support</span>}
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
              <p className="text-xs text-zinc-400">
                Find the lineup looks for who played in Clashfinder, the promoter's page and ticketing listings. It cites every act and never guesses. The link is optional.
              </p>
              <input className={input} value={lineupUrl} onChange={(e) => setLineupUrl(e.target.value)} placeholder="Lineup page, if you know one (optional)" />
            </div>
          )}
          {edition && (
            <p className="text-sm text-zinc-300">
              {lineupActs.length} acts confirmed, each with a source.
              {job && (
                <Button className="ml-2" onClick={() => setReviewing(true)}>Edit lineup</Button>
              )}
            </p>
          )}
          {job && !edition && (
            <LineupProgress
              job={job}
              busy={busy === 'retry'}
              onRetry={() =>
                void run('retry', async () => {
                  await lineupApi.retry(job.id);
                  setTimeout(() => void load(), 500);
                })
              }
              onReview={() => setReviewing(true)}
            />
          )}
          {(!job || edition || job.status === 'no_data' || job.status === 'failed') && !isActive(job?.status) && (
            <div className="space-y-1.5">
              <Button
                onClick={() => run('lineup', async () => (await eventsApi.findLineup(event.id, lineupUrl || undefined)).event)}
                disabled={busy === 'lineup' || !(event.year || event.startDate)}
              >
                {busy === 'lineup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {job ? 'Look up the lineup again' : 'Find the lineup'}
              </Button>
              {!(event.year || event.startDate) && <p className="text-xs text-amber-300/90">Add when it was first, then find the lineup.</p>}
            </div>
          )}
        </section>

        {/* Your details */}
        <section className="space-y-3">
          <h3 className={sectionTitle}>Your notes</h3>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Format</span>
            <ChipInput
              items={formatsOf(event.format)}
              placeholder="Club night, warehouse party, block party…"
              past={formatSuggestions}
              label="Add a format"
              onChange={(formats) => save({ format: joinFormats(formats) })}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Went with</span>
            {event.peopleLocked ? (
              <span className="block rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-amber-300">🔒 Vault Locked</span>
            ) : (
              <ChipInput items={event.companions} placeholder="Add a name" past={pastCompanions} label="Add who you went with" onChange={(companions) => save({ companions })} />
            )}
          </label>
          {onManage && manageLinks(event).length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
              <FolderCog className="h-3 w-3" /> Edit on every event in Manage:
              {manageLinks(event).map((m) => (
                <button
                  key={`${m.target.kind}:${m.target.id}`}
                  onClick={() => onManage(m.target)}
                  className="rounded-full border border-zinc-800 px-2 py-0.5 text-zinc-300 hover:text-violet-300"
                >
                  {m.label}
                </button>
              ))}
            </p>
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
              field="ticketPrice"
              type="number"
              value={event.ticketPrice}
              source={event.sources.ticketPrice}
              onSave={(v) => save({ ticketPrice: v ? Number(v) : null })}
              className="w-32"
            />
          </div>
          <NotesField stored={event.notes} onSave={(v) => save({ notes: v })} />
        </section>

        <div className="flex items-center justify-between border-t border-zinc-900 pt-4">
          <div className="flex items-center gap-4">
            {onOpenHistory && (
              <button onClick={() => onOpenHistory(event.id)} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-violet-300">
                <History className="h-3.5 w-3.5" /> History
              </button>
            )}
            <button
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-rose-300"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete event
            </button>
          </div>
        </div>
      </FlashContext.Provider>

      {confirmingDelete && (
        <Confirm
          title="Delete show"
          message={`"${eventTitle(event)}" moves to Recently deleted in the Log, where you can restore it for 90 days.`}
          confirmLabel="Delete show"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void run('delete', async () => {
              await eventsApi.remove(event.id);
              toast({ message: `Deleted ${eventTitle(event)}` });
              onDeleted();
            });
          }}
        />
      )}
      {reviewing && job && (
        <LineupReview
          job={job}
          event={event}
          edition={edition}
          onClose={() => setReviewing(false)}
          onSaved={(updated) => {
            setReviewing(false);
            onChange(updated);
            void load();
          }}
        />
      )}
    </DetailShell>
  );
};
