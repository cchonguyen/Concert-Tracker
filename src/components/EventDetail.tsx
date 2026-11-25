import { useVault } from './VaultContext';
import { useIsOwner } from './MeContext';
import { noteView } from '../services/vaultSession';
import { draftAfterStoredChange } from '../services/fieldDraft';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleHelp, CloudSun, ExternalLink, FolderCog, Heart, History, ListMusic, Loader2, Plus, RefreshCw, Search, Trash2, Users, X } from 'lucide-react';
import {
  ArtistSuggestion,
  canonicalApi,
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
  FIELD_SOURCE_LABELS,
  SOURCE_LABELS,
} from '../services/lineupApi';
import { editionUrl, isModifiedClick, rememberManageSearch } from '../services/manageNav';
import { artistsOf, dateConfirmations, datesBetween, formatsOf, joinFormats, matchNames, pastArtistNames, pastCompanionNames, pastSets, supportOf, weekendLabel, weatherLine, whenLabel } from '../services/format';
import { actSets, byStartTime, chipTime, setLabel } from '../server/events/sets';
import { eventScale, KIND_LABELS, lineupFacts } from '../server/events/scale';
import { LineupReview } from './LineupReview';
import { groupReviewSlots, pendingReplacement } from '../services/reviewRows';
import { norm } from '../services/listImport';
import { placeForVenue } from '../services/venuePlace';
import { emptyPlaceFields, type VenueLocation } from '../server/canon/venueLocation';
import { isSampleMode } from '../services/sampleMode';
import { leaveB2b, pairB2b, seenSlots, SET_LABELS, setSolo, SlotAct, slotId, toSeenInput } from '../server/events/seen';
import { eventTitle, seriesList, seriesOffers } from '../services/series';
import { SuggestInput } from './SuggestInput';
import { usePlaceAutofill } from './PlaceFields';
import { buildPastPlaces, cityPickPatch } from '../services/placeAutofill';
import { SeenGenres } from './SeenGenres';
import { EventTitle } from './EventTitle';
import { hasGap, type Gap } from '../services/table';
import { dateText, GAP_SECTION, needsWeekendPrompt, thingsLeft } from '../services/poster';
import { rememberSection, sectionOpen } from '../services/sectionMemory';
import { Popover } from './ui/Popover';
import { Burst } from './ui/Burst';
import { burstConfetti } from './ui/confetti';
import { PosterHeader, ThingsLeft } from './PosterHeader';
import { Stars } from './ui/Stars';
import { Tabs } from './ui/Tabs';
import { cityWithRegion, sameCountry } from '../server/events/regions';
import { attendanceOf } from '../server/events/attendance';
import type { EditionPerformance, InferenceField } from '../server/lineup/types';
import type { InferredField } from '../server/canon/inferences';
// The inferred value with its member votes and standing, as GET /events/:id returns it.
type InferredView = InferredField & { votes?: number; standing?: 'inferred' | 'candidate' };
import type { InferredBilling } from '../server/canon/inferredBilling';
import type { ManageTarget } from './ManageView';
import { DetailShell, type DetailRow } from './ui/DetailShell';
import { Confirm } from './ui/Confirm';
import { VersionPicker } from './ui/VersionPicker';
import { PasteSetTimes } from './PasteSetTimes';
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
import { scrollBehavior } from '../services/motion';
import { motion, useReducedMotion } from 'motion/react';

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
      <span className="text-[11px] font-semibold text-text-muted">
        Notes {locked && <span className="ml-1 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-warn">{view.badge}</span>}
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
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text placeholder-text-faint focus:border-accent focus:outline-none';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';
// A card's own title, as in the design: plain words, not small capitals.
const cardTitle = 'text-base font-semibold text-text';
const card = 'scroll-mt-16 space-y-3 rounded-card border border-line bg-surface-1 p-4';
// A card under folder tabs: square on top, with the tab row's stronger line.
const tabbedCard = 'scroll-mt-16 space-y-3 rounded-b-card border border-t-0 border-line-strong bg-surface-1 p-4';

// A "?" beside a section title, with two or three sentences on how the section works.
const SectionHelp: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <Popover label={`About ${label}`} content={<p className="max-w-xs text-xs leading-relaxed text-text">{children}</p>}>
    <button type="button" aria-label={`About ${label}`} className="flex h-9 w-9 items-center justify-center rounded-control text-text-muted hover:text-text sm:h-7 sm:w-7">
      <CircleHelp className="h-4 w-4" aria-hidden="true" />
    </button>
  </Popover>
);

// Typing saves 500 ms after the last key, so a sheet closed at once (iOS Safari) still gets its last value through the blur flush.
const SAVE_DELAY_MS = 500;
// Counts how many times an event has been opened on this device, for the "Changes save as you go" hint.
const HINT_KEY = 'liveArchive.saveHint';
// The fields a save has just written; each one flashes for a moment.
const FlashContext = React.createContext<string[]>([]);
const EditionIdContext = React.createContext<string | undefined>(undefined);

// An inferred value beside an empty field (never in the input). Its reason opens on hover or tap.
// A member's Verify counts toward it; the owner's Confirm writes it into the event as theirs.
const InferredNote: React.FC<{ inferred: InferredView; type: string; onAct?: (inferenceId: string) => Promise<void> }> = ({ inferred, type, onAct }) => {
  const isOwner = useIsOwner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const raw = String(inferred.value);
  const shown = type === 'date' ? (whenLabel({ startDate: raw }) ?? raw) : raw;
  const reason = inferred.reason.replace(/[.\s]+$/, '');
  const votes = inferred.votes ?? 0;
  const label = inferred.standing === 'candidate' ? `Candidate, ${votes} member${votes === 1 ? '' : 's'}` : 'Inferred';
  const act = async () => {
    if (!onAct) return;
    setBusy(true);
    setError(null);
    try {
      await onAct(inferred.inferenceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm italic text-text-muted">
      <span>{shown}</span>
      <Popover label="Why this is inferred" content={<p className="max-w-xs text-xs leading-relaxed text-text">{`Inferred: ${reason}.`}</p>}>
        <button type="button" aria-label="Why this is inferred" className="rounded-full">
          <Pill tone="inferred">{label}</Pill>
        </button>
      </Popover>
      {onAct && (
        <button
          type="button"
          onClick={act}
          disabled={busy}
          title={isOwner ? 'Writes this value into the event as yours.' : 'Your Verify counts toward this value. Two members make it verified.'}
          className="not-italic inline-flex min-h-9 items-center rounded-control border border-line px-3 text-xs text-text hover:bg-surface-2 disabled:opacity-50"
        >
          {isOwner ? 'Confirm' : 'Verify'}
        </button>
      )}
      {error && <span role="alert" className="not-italic text-xs text-bad">{error}</span>}
    </div>
  );
};

// An inferred billing role on an act with no stated role. Its reason opens on tap.
const InferredRole: React.FC<{ inferred: InferredBilling }> = ({ inferred }) => {
  const reason = inferred.reason.replace(/[.\s]+$/, '');
  return (
    <Popover label="Why this role is inferred" content={<p className="max-w-xs text-xs leading-relaxed text-text">{`Inferred: ${reason}.`}</p>}>
      <button type="button" aria-label="Why this role is inferred" className="rounded-full">
        <Pill tone="inferred">{inferred.role === 'headliner' ? 'Inferred headliner' : 'Inferred support'}</Pill>
      </button>
    </Popover>
  );
};

// A text field that saves when you leave it, and 500 ms after you stop typing.
const Field: React.FC<{
  label: string;
  value?: string | number;
  type?: string;
  placeholder?: string;
  source?: LoggedEvent['sources'][keyof LoggedEvent['sources']];
  onSave: (value: string) => void | Promise<unknown>;
  onType?: (value: string) => void;
  suggestions?: string[];
  // A confirmed source gives a different value: one tap takes it.
  offer?: { value: string; from: string; onUse: () => void };
  min?: string;
  className?: string;
  // The event field this saves, so a save of it flashes.
  field?: keyof EventPatch;
  // Shown only while the stored value is empty; never put into the input or saved.
  inferred?: InferredView;
  onInferredAct?: (inferenceId: string) => Promise<void>;
}> = ({ label, value, type = 'text', placeholder, source, onSave, onType, suggestions, offer, min, className, field, inferred, onInferredAct }) => {
  const flashing = React.useContext(FlashContext);
  const isOwner = useIsOwner();
  const editionId = React.useContext(EditionIdContext);
  const flash = field !== undefined && flashing.includes(field);
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [settled, setSettled] = useState(0);
  // True between focus and blur. A stored value that arrives while the person is typing does not replace the draft.
  const editing = useRef(false);
  const awaiting = useRef(0);
  const mounted = useRef(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const skipBlur = useRef(false);
  useEffect(() => () => {
    mounted.current = false;
  }, []);
  useEffect(() => {
    if (awaiting.current > 0) return;
    const stored = value === undefined ? '' : String(value);
    setDraft((prev) => draftAfterStoredChange(prev, stored, editing.current));
  }, [value, settled]);
  const pending = useRef<number | null>(null);
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };
  // Saves the draft now if it differs from the stored value, and cancels any timed save.
  const flush = () => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = null;
    const now = latest.current;
    if (now.draft === (now.value === undefined ? '' : String(now.value))) return;
    const res = now.onSave(now.draft);
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      awaiting.current += 1;
      void Promise.resolve(res).then(
        (ok) => {
          awaiting.current -= 1;
          if (mounted.current && awaiting.current === 0 && ok !== false) setSettled((n) => n + 1);
        },
        () => {
          awaiting.current -= 1;
        },
      );
    }
  };
  const scheduleSave = () => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };
  // Leaving the field with a save still waiting saves it.
  useEffect(() => () => flush(), []);
  const handleBlur = () => {
    editing.current = false;
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    flush();
  };
  return (
    <div ref={boxRef} className={`-m-0.5 space-y-1 rounded-lg p-0.5 transition-shadow motion-reduce:transition-none ${flash ? 'ring-1 ring-good/60' : ''} ${className ?? ''}`}>
      <label className="block space-y-1">
        <span className="flex items-center justify-between gap-2 text-[11px] font-semibold text-text-muted">
          <span className="inline-flex items-center gap-1">
            {label}
            {flash && <Check className="h-3 w-3 text-good" aria-label="Saved" />}
          </span>
          {source && source.sourceType === 'edition' && (
            isOwner && editionId ? (
              <a
                href={editionUrl(editionId)}
                onClick={(e) => {
                  if (isModifiedClick(e)) return;
                  e.preventDefault();
                  const url = editionUrl(editionId);
                  window.history.pushState({ fromManageList: false }, '', url);
                  rememberManageSearch(new URL(url, window.location.origin).search);
                  window.dispatchEvent(new PopStateEvent('popstate'));
                }}
                className="font-normal text-text-muted hover:text-accent hover:underline"
              >
                from {FIELD_SOURCE_LABELS.edition}
              </a>
            ) : (
              <span className="font-normal text-text-muted">from {FIELD_SOURCE_LABELS.edition}</span>
            )
          )}
          {source && source.sourceType !== 'user' && source.sourceType !== 'edition' && (
            <a
              href={source.sourceUrl}
              target="_blank"
              rel="noreferrer"
              title={source.quote ? `“${source.quote}”` : undefined}
              className="inline-flex items-center gap-0.5 font-normal text-text-muted hover:text-accent"
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
            onFocus={() => (editing.current = true)}
            onBlur={handleBlur}
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
            onFocus={() => (editing.current = true)}
            onBlur={handleBlur}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        )}
      </label>
      {inferred && (value === undefined || String(value).trim() === '') && <InferredNote inferred={inferred} type={type} onAct={onInferredAct} />}
      {offer && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (pending.current !== null) {
              window.clearTimeout(pending.current);
              pending.current = null;
            }
            editing.current = false;
            const inputEl = boxRef.current?.querySelector('input');
            if (inputEl && document.activeElement === inputEl) {
              skipBlur.current = true;
              inputEl.blur();
            }
            offer.onUse();
          }}
          className="block w-full truncate text-left text-[11px] text-accent hover:underline"
        >
          Use “{offer.value}” from {offer.from}
        </button>
      )}
    </div>
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
    <div className="rounded-lg border border-line bg-surface-2 p-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => (
          <span key={`${item}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-surface-3 py-1 pl-2.5 pr-1.5 text-sm text-text">
            {item}
            <button onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${item}`} className="text-text-muted hover:text-text">
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
          className="min-w-[8rem] flex-1 bg-transparent px-1.5 py-1 text-sm text-text placeholder-text-faint focus:outline-none"
        />
      </div>
      {matches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1 pt-1.5" role="listbox" aria-label="Names you've entered before">
          <span className="text-[11px] text-text-muted">Before:</span>
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
                i === active ? 'border-accent bg-accent-tint text-text' : 'border-line-strong text-text-muted hover:border-accent'
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
    <div className="col-span-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span className="font-semibold text-text-muted">Days you went{went.length === days.length ? ' (all)' : ''}:</span>
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
            className={`rounded-full border px-2.5 py-1 ${on ? 'border-accent bg-accent-tint text-text' : 'border-line text-text-muted line-through'}`}
          >
            {new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })}
          </button>
        );
      })}
    </div>
  );
};

// The seen tick draws itself (design-refresh-2.md, section 4); under reduced motion it is simply there.
const DrawnTick: React.FC<{ className?: string }> = ({ className = 'h-4 w-4' }) => {
  const still = useReducedMotion();
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <motion.path d="M20 6 9 17l-5-5" initial={still ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, ease: 'easeOut' }} />
    </svg>
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
  const box = 'space-y-2 rounded-xl border p-4 text-sm';

  if (offered) {
    const toggle = (o: Offered) =>
      onSave({
        seen: seenKeys.has(o.key)
          ? toPatch(event.seen.filter((s) => s.key !== o.key))
          : [...toPatch(event.seen), { name: o.name, from: o.from, role: o.role, roleFrom: o.role ? o.from : undefined }],
      });
    return (
      <div className={`${box} border-good/45 bg-good/10`}>
        <p className="inline-flex items-center gap-1 font-semibold text-good">
          <DrawnTick /> Counted. Who did you see?
        </p>
        {offered.length > 0 && (
          <>
            <p className="text-xs text-text-muted">
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
                    className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-2.5 py-1 text-xs sm:min-h-9 ${on ? 'border-accent bg-accent-tint text-text' : 'border-line text-text-muted hover:text-text'}`}
                  >
                    {on && <DrawnTick className="h-3 w-3 text-accent" />}
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
          <span className="text-xs text-text-muted">Add anyone else under Who you saw.</span>
        </div>
      </div>
    );
  }

  if (state === 'upcoming') return null; // The poster says it is not counted yet.

  if (state === 'missed') {
    return (
      <div className={`${box} flex flex-wrap items-center justify-between gap-2 border-line text-text-muted`}>
        <span>You didn't go, so it isn't counted.</span>
        <button onClick={() => onSave({ attendance: null })} className="text-xs text-text-muted hover:underline">
          I did go
        </button>
      </div>
    );
  }

  if (state !== 'confirm') return null;
  const went = () => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) burstConfetti();
    onSave({ attendance: null });
    const acts: Offered[] = [
      ...event.seen.map((s) => ({ key: s.key, name: s.name, from: s.from, role: s.role })),
      ...lineupActs.filter((p) => !seenKeys.has(p.artistKey)).map((p) => ({ key: p.artistKey, name: p.name, from: 'lineup' as const, role: p.billing })),
    ];
    if (acts.length || days.length > 1 || canReview) setOffered(acts);
  };
  return (
    <div className={`${box} border-accent-tint-line bg-accent-tint`}>
      <p className="font-semibold text-text">Did you go?</p>
      <p className="text-xs text-text-muted">It's over, and it stays out of Stats, Artists and the Map until you say.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={went}>Yes, I went</Button>
        <Button onClick={() => onSave({ attendance: 'missed' })}>No, I didn't go</Button>
      </div>
    </div>
  );
};

// Who you saw. Each act is a row that shows only what is stored about it; a tap on the row opens its editor in a Sheet.
// Typing offers acts you've entered on other events; a click, or arrow keys then Enter, adds one as you spelled it
// before. Enter alone adds what you typed. Typing a B2B act's name again adds its solo set.
const SeenActs: React.FC<{
  seen: Seen[];
  sets: Map<string, string>;
  past: string[];
  pastSets: string[];
  inferredBilling: Record<string, InferredBilling>;
  onChange: (seen: SeenPatch) => void;
}> = ({
  seen,
  sets,
  past,
  pastSets: pastSetsList,
  inferredBilling,
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
  // One act's name and what is stored about it. The whole row is the button that opens its editor.
  const act = (s: SlotAct<Seen>) => (
    <React.Fragment key={s.asSolo ? `${s.key}:solo` : s.key}>
      <span className="text-sm font-medium text-text">{s.name}</span>
      {s.set && (
        <Pill tone="info">
          {s.set.toLowerCase() === 'dj' || s.set.toLowerCase() === 'dj set'
            ? 'DJ'
            : s.set.toLowerCase() === 'live' || s.set.toLowerCase() === 'live set'
              ? 'Live'
              : s.set}
        </Pill>
      )}
      {s.role === 'headliner' && <Pill tone="highlight">Headliner</Pill>}
      {!s.role && inferredBilling[s.key] && <InferredRole inferred={inferredBilling[s.key]} />}
      {s.asSolo && <Pill>Solo</Pill>}
    </React.Fragment>
  );
  // Favourite sets: turning this on marks the set as a favourite.
  type SeenWithMeta = Seen & { _instanceId: string; _index: number };
  const seenWithMeta: SeenWithMeta[] = seen.map((s, i) => ({
    ...s,
    _instanceId: s.id ?? `${s.key}:${i}`,
    _index: i,
  }));
  const artists = seenWithMeta.filter((s) => s.role !== 'support');
  const support = seenWithMeta.filter((s) => s.role === 'support');
  // One row per slot: a B2B shows its acts in one row, joined by "B2B". The heart toggles the favourite set and the rest
  // of the row opens the act's editor, so each part of the row does one thing.
  const slot = (acts: Array<SlotAct<SeenWithMeta>>) => {
    const favourite = acts.some((a) => a.favourite);
    const time = acts.map((a) => sets.get(a.key)).find(Boolean);
    const untyped = acts.find((a) => !a.set);
    const primary = acts[0];
    const instanceId = primary._instanceId + (primary.asSolo ? ':solo' : '');
    return (
      <li
        key={slotId(acts)}
        className={`flex items-stretch overflow-hidden rounded-lg border ${favourite ? 'border-rose-400/50 bg-rose-500/[0.06]' : 'border-line bg-sunken'}`}
      >
        <button
          type="button"
          onClick={() => {
            const targetIndices = new Set(acts.map((a) => a._index));
            const nextOn = !acts.some((a) => a.favourite);
            onChange(toPatch(seen).map((s, i) => (targetIndices.has(i) ? { ...s, favourite: nextOn } : s)));
          }}
          aria-pressed={favourite}
          aria-label={favourite ? 'Favourite set. Tap to unset.' : 'Mark as favourite set'}
          title={favourite ? 'Favourite set' : 'Mark as favourite set'}
          className="flex w-11 shrink-0 items-center justify-center hover:bg-rose-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:w-10"
        >
          <Heart className={`h-4 w-4 ${favourite ? 'fill-rose-400 text-rose-400' : 'text-text-faint'}`} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setEditing(instanceId)}
          title="Opens this act's billing, set type and B2B partners."
          className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-2 pr-3 text-left hover:bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:min-h-0"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {acts.some((a) => a.alias) && (
              <span className="font-semibold text-text mr-0.5">
                {acts.find((a) => a.alias)?.alias}
              </span>
            )}
            {acts.some((a) => a.alias) && <span className="text-xs text-text-muted mr-0.5">(</span>}
            {acts.map((a, i) => (
              <React.Fragment key={a.key}>
                {i > 0 && <Pill tone="accent">B2B</Pill>}
                {act(a)}
              </React.Fragment>
            ))}
            {acts.some((a) => a.alias) && <span className="text-xs text-text-muted">)</span>}
          </span>
          {time && <span className="shrink-0 text-xs tabular-nums text-text-muted">{time}</span>}
          {!time && untyped && <span className="shrink-0 rounded-full border border-warn/45 px-2 py-0.5 text-xs text-warn">Set type?</span>}
        </button>
      </li>
    );
  };
  const editingAct = seenWithMeta.find((s) => s._instanceId === editing || `${s._instanceId}:solo` === editing);
  return (
    <div className="space-y-2">
      {/* The list scrolls in its own box, with the bar always there, so a long bill does not push the rest of the card down. */}
      <div className="max-h-80 space-y-2 overflow-y-scroll pr-1">
        {artists.length > 0 ? (
          <ul className="space-y-1.5" aria-label="Artists">{seenSlots(artists).map(slot)}</ul>
        ) : (
          <p className="text-xs text-text-muted">None yet. Add who you saw below.</p>
        )}
        {support.length > 0 && (
          <>
            <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Supporting</p>
            <ul className="space-y-1.5" aria-label="Supporting">{seenSlots(support).map(slot)}</ul>
          </>
        )}
      </div>
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
        className="w-full rounded-lg border border-dashed border-line-strong bg-transparent px-3 py-2 text-sm text-text placeholder-text-faint focus:border-accent focus:outline-none"
      />
      {matches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1" role="listbox" aria-label="Acts you've entered before">
          <span className="text-[11px] text-text-muted">Seen before:</span>
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
                i === active ? 'border-accent bg-accent-tint text-text' : 'border-line-strong text-text-muted hover:border-accent'
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
            actIndex={editingAct._index}
            time={sets.get(editingAct.key)}
            pastSets={pastSetsList}
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
  actIndex?: number;
  time?: string;
  pastSets?: string[];
  onChange: (seen: SeenPatch) => void;
  onRemoved: () => void;
}> = ({ seen, act, actIndex, time, pastSets: pastSetsList = [], onChange, onRemoved }) => {
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const targetIndex = actIndex !== undefined ? actIndex : seen.findIndex((s) => (s.id && act.id ? s.id === act.id : s.key === act.key));
  const key = act.key;
  const patchAct = (change: Partial<SeenPatch[number]>) =>
    onChange(toPatch(seen).map((s, i) => (i === targetIndex ? { ...s, ...change } : s)));
  const partners = seen.filter((s, i) => i !== targetIndex && act.b2b?.includes(s.key));
  const free = seen.filter((s, i) => i !== targetIndex && !act.b2b?.includes(s.key));
  const [bursts, setBursts] = useState(0);
  const billingHelp = !act.role
    ? 'No role stated, so it counts as Artist.'
    : act.roleFrom === 'you'
      ? 'Your choice.'
      : act.roleFrom === 'lineup'
        ? 'From the lineup. Changing it here makes it your choice.'
        : 'Set on this act. Changing it here makes it your choice.';
  return (
    <div className="space-y-5">
      {time && <p className="text-sm text-text-muted">Set time: {time}</p>}
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
        <p className="text-xs text-text-muted">{billingHelp}</p>
      </section>
      <section className="space-y-2">
        <h4 className={sectionTitle}>Set</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              const isDj = act.set?.toLowerCase() === 'dj set' || act.set?.toLowerCase() === 'dj';
              patchAct({ set: isDj ? null : 'DJ Set' });
            }}
            aria-pressed={act.set?.toLowerCase() === 'dj set' || act.set?.toLowerCase() === 'dj'}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              act.set?.toLowerCase() === 'dj set' || act.set?.toLowerCase() === 'dj'
                ? 'border-accent bg-accent-tint font-medium text-text'
                : 'border-line text-text-muted hover:border-line-strong hover:text-text'
            }`}
          >
            DJ Set
          </button>
          <button
            type="button"
            onClick={() => {
              const isLive = act.set?.toLowerCase() === 'live' || act.set?.toLowerCase() === 'live set';
              patchAct({ set: isLive ? null : 'Live' });
            }}
            aria-pressed={act.set?.toLowerCase() === 'live' || act.set?.toLowerCase() === 'live set'}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              act.set?.toLowerCase() === 'live' || act.set?.toLowerCase() === 'live set'
                ? 'border-accent bg-accent-tint font-medium text-text'
                : 'border-line text-text-muted hover:border-line-strong hover:text-text'
            }`}
          >
            Live
          </button>
          {Boolean(act.set) && (
            <button
              type="button"
              onClick={() => patchAct({ set: null })}
              title="Clears the set type."
              aria-label="Clear set"
              className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-text-muted hover:border-line-strong hover:text-text"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>
        <SuggestInput
          value={act.set ?? ''}
          suggestions={pastSetsList}
          onPick={(val) => patchAct({ set: val.trim() || null })}
          onChange={(e) => patchAct({ set: e.target.value || null })}
          onBlur={(e) => patchAct({ set: e.target.value.trim() || null })}
          placeholder="e.g. Throwback Set, Sunrise Set, HOLO, Redux"
          aria-label="Set format or theme"
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-text placeholder-text-faint focus:border-accent focus:outline-none"
        />
      </section>
      <section className="space-y-2">
        <h4 className={sectionTitle}>Played B2B with</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {partners.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1 rounded-full bg-surface-3 py-1 pl-2.5 pr-1 text-sm text-text">
              {p.name}
              <button
                type="button"
                onClick={() => onChange(toPatch(leaveB2b(seen, p.key)))}
                aria-label={`Take ${p.name} out of the B2B`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:text-text"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {!partners.length && <span className="text-xs text-text-muted">No one yet.</span>}
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
        <p className="text-xs text-text-muted">Both still count as seen, each with full credit.</p>
      </section>
      {partners.length > 0 && (
        <section className="space-y-1.5">
          <h4 className={sectionTitle}>Name they play under together</h4>
          <input
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-text placeholder-text-faint focus:border-accent focus:outline-none"
            placeholder="e.g. Subjohnics, Kx5, ISOKNOCK"
            value={act.alias ?? ''}
            onChange={(e) => {
              const val = e.target.value.trim() || undefined;
              const partnerKeys = new Set([key, ...partners.map((p) => p.key)]);
              onChange(toPatch(seen.map((s) => (partnerKeys.has(s.key) ? { ...s, alias: val } : s))));
            }}
          />
          <p className="text-xs text-text-muted">Optional, e.g. Subjohnics for John Summit B2B Subtronics.</p>
        </section>
      )}
      {partners.length > 0 && (
        <Switch checked={Boolean(act.solo)} onChange={(v) => onChange(toPatch(setSolo(seen, key, v)))} label="Also played a solo set" />
      )}
      <div className="relative">
        <Switch
          checked={Boolean(act.favourite)}
          onChange={(v) => {
            if (v) setBursts((n) => n + 1);
            onChange(toPatch(seen).map((s, i) => (i === targetIndex ? { ...s, favourite: v } : s)));
          }}
          label="Favourite set"
          helper="Mark sets that were highlights of the event."
        />
        <Burst icon={Heart} trigger={bursts} />
      </div>
      <Button
        variant="danger"
        className="w-full"
        onClick={() => {
          const before = seen;
          onChange(toPatch(seen.filter((_, i) => i !== targetIndex)));
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
        <p className="inline-flex items-center gap-1 text-text-muted">
          <CloudSun className="h-3.5 w-3.5 text-text-muted" /> Weather
        </p>
        <ul className="space-y-0.5 text-text-muted">
          {w.days.map((d) => (
            <li key={d.date}>
              {w.days.length > 1 && <span className="text-text-muted">{whenLabel({ startDate: d.date })}: </span>}
              {weatherLine(d) || 'No reading'}
            </li>
          ))}
        </ul>
        <a href={w.sourceUrl} target="_blank" rel="noreferrer" className="text-text-muted hover:text-accent">
          Open-Meteo archive, {w.place} <ExternalLink className="inline h-2.5 w-2.5" />
        </a>
      </div>
    );
  }
  if (!event.startDate || !event.city) return null;
  return (
    <div className="space-y-1">
      <button onClick={onLookUp} disabled={busy} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text disabled:opacity-50">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudSun className="h-3 w-3" />} Look up the weather
      </button>
      {note && <p className="text-xs text-text-muted">{note}</p>}
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


export const EventDetail: React.FC<EventDetailProps> = ({ event, events, onChange, onDeleted, onClose, rows, onOpen, onManage, onOpenHistory }) => {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const isOwner = useIsOwner();
  const canManageEdition = isOwner || Boolean(onManage);
  const [job, setJob] = useState<LookupJob | null>(null);
  const [edition, setEdition] = useState<Edition | null>(null);
  const [inferred, setInferred] = useState<Partial<Record<InferenceField, InferredView>>>({});
  const [inferredBilling, setInferredBilling] = useState<Record<string, InferredBilling>>({});
  const [suggestions, setSuggestions] = useState<ArtistSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineupUrl, setLineupUrl] = useState('');
  // Whether Gemini is set up and how much of today's budget is left, for
  // "Deep search with AI".
  const [lineupStatus, setLineupStatus] = useState<LineupStatus | null>(null);
  useEffect(() => {
    lineupApi.status().then(setLineupStatus, () => setLineupStatus(null));
  }, [event.details.checkedAt]);
  const [showLog, setShowLog] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [lineupStage, setLineupStage] = useState<string>('all');
  const [lineupDay, setLineupDay] = useState<string>('all');
  const [lineupSearch, setLineupSearch] = useState<string>('');
  const [weekendPromptDismissed, setWeekendPromptDismissed] = useState(false);
  const whenWhereRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setLineupStage('all');
    setLineupDay('all');
    setLineupSearch('');
    setWeekendPromptDismissed(false);
  }, [event.id]);

  const others = events.filter((e) => e.id !== event.id);
  const [venueChoices, setVenueChoices] = useState<VenueLocation[]>([]);
  const pastVenues = pastValues(others, 'venue');
  // Cities you gave before, as "Las Vegas, NV": picking one brings its state
  // and, when none is stored, its country.
  const { places: pastPlaces, cities: pastCities } = useMemo(() => buildPastPlaces(others), [events, event.id]);
  const { setCityQuery, citySuggestions, mapOffer } = usePlaceAutofill({
    city: event.city,
    region: event.region,
    country: event.country,
    pastCities,
    guessDelayMs: 0,
  });
  const saveCity = (v: string) => save(cityPickPatch(text(v), pastPlaces, event.country));
  const formatSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of others) for (const v of formatsOf(e.format)) counts.set(v, (counts.get(v) ?? 0) + 1);
    const past = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
    return [...new Set([...past, ...FORMAT_IDEAS])];
  }, [events, event.id]);
  const pastArtists = useMemo(() => pastArtistNames(others), [events, event.id]);
  const pastCompanions = useMemo(() => pastCompanionNames(others), [events, event.id]);
  const pastSetsList = useMemo(() => pastSets(events), [events]);

  // A member's Verify, or the owner's Confirm, on an inferred value of this event. Reloads to show the result.
  const verifyInferred = async (inferenceId: string) => {
    if (isOwner) await canonicalApi.confirmInference(inferenceId);
    else await eventsApi.verifyInference(event.id, inferenceId);
    await load();
  };

  const load = useCallback(async () => {
    try {
      const data = await eventsApi.get(event.id);
      setJob(data.job);
      setEdition(data.edition);
      setInferred(data.inferred ?? {});
      setInferredBilling(data.inferredBilling ?? {});
      setSuggestions(data.suggestions ?? []);
      // Slower: parts of the name MusicBrainz knows as artists.
      eventsApi
        .nameArtists(event.id)
        .then((more) => setSuggestions((list) => [...list, ...more.filter((m) => !list.some((s) => s.key === m.key))]))
        .catch(() => undefined);
      if (data.event && data.event.details.status !== event.details.status) {
        onChangeRef.current(data.event);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [event.id, event.details.status]);

  useEffect(() => {
    void load();
  }, [load, event.lineupJobId, event.editionId, event.seen.length, event.details.status]);

  useEffect(() => {
    const isJobActive = isActive(job?.status);
    const isDetailsPending = event.details.status === 'pending';
    if (!isJobActive && !isDetailsPending) return;

    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await eventsApi.pollOne(event.id);
        if (!live) return;
        setJob(res.job);
        const jobFinished = isJobActive && !isActive(res.job?.status);
        const detailsDone = isDetailsPending && res.detailsStatus !== 'pending';
        if (jobFinished || detailsDone) {
          void load();
          return;
        }
      } catch {
        // Keep polling on transient error
      }
      if (live) {
        timer = setTimeout(poll, 2000);
      }
    };

    timer = setTimeout(poll, 2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [event.id, event.details.status, job?.status, load]);

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
  const pendingSaves = useRef(new Set<Promise<unknown>>());
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
  const sendPatch = (patch: EventPatch): Promise<boolean> => {
    update(beginSave);
    const sent = eventsApi.update(event.id, patch).then(
      (updated) => {
        onChange(updated);
        update((t) => succeedSave(t, Date.now()));
        flash(Object.keys(patch));
        return true;
      },
      () => {
        update((t) => failSave(t, patch));
        return false;
      },
    );
    pendingSaves.current.add(sent);
    void sent.finally(() => pendingSaves.current.delete(sent));
    return sent;
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
  const chipTimes = new Map<string, string>(); // "Fri 19:00" under a lineup chip
  const starts = new Map<string, string>(); // earliest start, to order a timed lineup
  for (const p of [
    ...(job?.candidate?.performers ?? []).map((c) => ({ key: c.key, sources: c.sources })),
    ...lineupActs.map((c) => ({ key: c.artistKey, sources: c.sources })),
  ]) {
    const all = actSets(p);
    const onDays = all.filter((s) => s.day && event.daysAttended.includes(s.day));
    const shown = onDays.length ? onDays : all;
    if (shown.length) sets.set(p.key, shown.map((s) => setLabel(s, multiDay)).join('; '));
    const short = chipTime(shown, multiDay);
    if (short) chipTimes.set(p.key, short);
    const first = shown.find((s) => s.start)?.start;
    if (first) starts.set(p.key, first);
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
    const same = field === 'country' ? sameCountry(v, yours) : v === yours;
    if (!confirmed || !v || same || (field === 'city' && v === event.city)) return undefined;
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
  const worked = eventScale({ ...event, kind: undefined }, edition ? lineupFacts(edition) : undefined);
  const offered = suggestions.filter((s) => !seenKeys.has(s.key));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const toast = useToast();
  const roleName = (role?: Seen['role']) => (role === 'support' ? 'Supporting' : 'Artist');

  const state = attendanceOf(event, new Date().toISOString().slice(0, 10));
  const gapsLeft = thingsLeft(event, (e, g) => hasGap(e, g, undefined, edition ? lineupFacts(edition) : undefined));
  // Scrolls to the section a gap is filled in and highlights it for a moment.
  const [rightTab, setRightTab] = useState<'seen' | 'lineup'>('seen');
  const showGap = (gap: Gap) => {
    setGuide(gap);
    // Open the Who you saw tab first, so its card is on screen to scroll to.
    if (GAP_SECTION[gap] === 'who-you-saw' && rightTab !== 'seen') {
      setRightTab('seen');
      window.requestAnimationFrame(() => revealGap(gap));
      return;
    }
    revealGap(gap);
  };
  const revealGap = (gap: Gap) => {
    const el = document.getElementById(GAP_SECTION[gap]);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    el.classList.add('ring-2', 'ring-accent/70', 'rounded-xl');
    window.setTimeout(() => el.classList.remove('ring-2', 'ring-accent/70', 'rounded-xl'), 1600);
    el.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
  };
  // The guided card asks the question for the gap the strip's Next went to, until that gap is filled.
  const [guide, setGuide] = useState<Gap | null>(null);
  // The Your night summary: who you went with and what the ticket cost, when you've said. Locked names stay hidden.
  const night = [
    !event.peopleLocked && event.companions.length ? `With ${event.companions.join(', ')}` : '',
    event.ticketPrice != null ? `Ticket ${event.ticketPrice}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const current = guide && gapsLeft.includes(guide) ? guide : (gapsLeft[0] ?? null);
  const at = current ? gapsLeft.indexOf(current) : -1;
  const [notesOpen] = useState(() => sectionOpen('notes', true));
  // While the lineup review is open, Escape and an outside press do not close the panel behind it.
  return (
    <DetailShell
      title={eventTitle(event)}
      rows={rows}
      openId={event.id}
      closeDisabled={reviewing}
      status={<SaveStatus track={track} onRetry={retrySaves} hint={hint} />}
      hero={
        <PosterHeader
          title={eventTitle(event)}
          label={[dateText(event), event.venue, cityWithRegion(event.city, event.region)].filter(Boolean).join(' · ') || 'No date yet'}
          event={event}
          state={state}
          seen={event.seen}
          cited={edition ? edition.performances.filter((p) => p.status !== 'cancelled').map((p) => p.artistKey) : []}
          confirmedBy={confirmations.length}
          onRate={(rating) => void save({ rating })}
        />
      }
      onGo={(id) => void goTo(id)}
      onClose={() => void requestClose()}
    >
      <FlashContext.Provider value={flashing}>
        <EditionIdContext.Provider value={event.editionId}>
          <ThingsLeft
          gaps={gapsLeft}
          current={current}
          needsWeekend={needsWeekendPrompt(event, edition)}
          onPick={showGap}
          onNext={() => showGap(gapsLeft[(at + 1) % gapsLeft.length])}
        />
        {error && <p className="rounded-lg border border-bad/40 bg-bad/10 p-2 text-sm text-bad">{error}</p>}
        <div className="grid min-w-0 gap-5 @[760px]:grid-cols-[1.15fr_1fr] @[760px]:items-start">
          <div className="min-w-0 space-y-5">
        {/* What it's called */}
        <section id="name-series" className={card}>
          <h3 className={cardTitle}>Name and series</h3>
          <div className="flex items-start gap-3">
            <Field label="Event" field="name" value={event.name} onSave={(v) => save({ name: v })} className="flex-1" />
          </div>
          {event.input && event.input !== event.name && <p className="text-xs text-text-muted">You typed: “{event.input}”</p>}
          <div className="space-y-1">
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Series"
                field="series"
                value={event.series}
                placeholder="Festival or tour it's one year of, e.g. EDC Las Vegas"
                suggestions={seriesOffers(event, others)}
                onSave={(v) => save({ series: text(v), ...(text(v) ? {} : { weekend: null }) })}
                className="flex-1"
              />
              {(event.series || (edition?.weekends && edition.weekends.length > 1)) && (
                <div className="space-y-1">
                  <span className="block text-[11px] font-semibold text-text-muted">Weekend</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {edition?.weekends && edition.weekends.length > 1
                      ? edition.weekends.map((w) => {
                          const on = event.weekend === w.weekend;
                          return (
                            <button
                              key={w.weekend}
                              type="button"
                              aria-pressed={on}
                              onClick={() => void save({ weekend: w.weekend })}
                              className={`min-h-11 rounded-control border px-3 text-sm sm:min-h-9 ${on ? 'border-accent bg-accent-tint text-text' : 'border-line-strong text-text-muted hover:border-accent'}`}
                            >
                              {weekendLabel(w, 'WK')}
                            </button>
                          );
                        })
                      : [1, 2].map((w) => {
                          const on = event.weekend === w;
                          return (
                            <button
                              key={w}
                              type="button"
                              aria-pressed={on}
                              onClick={() => void save({ weekend: w })}
                              className={`min-h-11 rounded-control border px-3 text-sm sm:min-h-9 ${on ? 'border-accent bg-accent-tint text-text' : 'border-line-strong text-text-muted hover:border-accent'}`}
                            >
                              WK{w}
                            </button>
                          );
                        })}
                    {event.weekend != null && (
                      <button
                        type="button"
                        onClick={() => void save({ weekend: null })}
                        className="min-h-11 px-2 text-xs text-text-muted hover:text-text sm:min-h-9"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            {(event.series || eventTitle(event) !== event.name) && (
              <p className="text-[11px] text-text-muted">
                Shows as “<EventTitle event={event} />”
                {(() => {
                  const n = seriesList(events).find((g) => g.name === event.series)?.events.length ?? 1;
                  return n > 1 ? ` · ${n} editions in your log` : '';
                })()}
              </p>
            )}
          </div>
        </section>

        <WentCard
          event={event}
          lineupActs={lineupActs}
          days={days}
          canReview={Boolean(job && job.status === 'needs_review' && !edition)}
          onSave={(patch) => void save(patch)}
          onReview={() => setReviewing(true)}
        />

        {/* Stage 1: when and where */}
        <section id="when-where" ref={whenWhereRef} className={card}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-0.5">
              <h3 className={cardTitle}>When and where</h3>
              <SectionHelp label="When and where">
                Check details searches for this date and place and lists what it finds below. Nothing you typed changes until you tap Use on a suggestion.
              </SectionHelp>
            </div>
            <button
              type="button"
              onClick={() => void run('research', () => eventsApi.research(event.id))}
              disabled={busy === 'research' || busy === 'research-gemini'}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-line-strong px-2.5 text-xs text-text hover:border-accent hover:text-accent disabled:opacity-50 sm:min-h-8"
            >
              {busy === 'research' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              Check details
            </button>
          </div>
          {needsWeekendPrompt(event, edition) && !weekendPromptDismissed && edition?.weekends && (
            <div className="space-y-2 rounded-lg border border-accent-tint-line bg-accent-tint p-2.5">
              <p className="text-sm font-medium text-text">Which weekend did you go?</p>
              <div className="flex flex-wrap items-center gap-2">
                {edition.weekends.map((w) => (
                  <button
                    key={w.weekend}
                    type="button"
                    onClick={() => void save({ weekend: w.weekend })}
                    className="min-h-11 rounded-control border border-accent-tint-line bg-accent-tint px-3 text-sm text-text hover:border-accent hover:bg-accent-tint sm:min-h-9"
                  >
                    {weekendLabel(w)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setWeekendPromptDismissed(true);
                    window.requestAnimationFrame(() => {
                      whenWhereRef.current?.querySelector<HTMLInputElement>('input[type="date"]')?.focus();
                    });
                  }}
                  className="min-h-11 px-2 text-xs text-text-muted hover:text-text hover:underline sm:min-h-9"
                >
                  Other dates
                </button>
              </div>
            </div>
          )}
          <CheckDetails
            inline
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
            onDismissCanon={() => void run('dismiss-canon', () => eventsApi.dismissCanon(event.id))}
            dismissBusy={busy === 'dismiss-canon'}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" field="startDate" type="date" value={event.startDate} source={event.sources.startDate} onInferredAct={verifyInferred} inferred={inferred.startDate} onSave={(v) => save({ startDate: text(v) })} />
            {/* Shows the start date until you change it, so the picker opens on the
                right month; stored only when it differs (a single-day event has no last day). */}
            <Field
              label="Last day"
              field="endDate"
              type="date"
              value={event.endDate ?? event.startDate}
              min={event.startDate}
              source={event.endDate ? event.sources.endDate : undefined}
              onInferredAct={verifyInferred} inferred={inferred.endDate}
              
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
              onInferredAct={verifyInferred} inferred={inferred.venue}
              suggestions={pastVenues}
              onSave={async (v) => {
                const venue = text(v);
                setVenueChoices([]);
                // A known venue fills only the empty city, state and country: from the place your other events
                // there agree on, else from the shared venue records (one place only; several are offered).
                let patch: Partial<Record<'city' | 'region' | 'country', string>> = {};
                const own = venue ? placeForVenue(others, venue) : undefined;
                if (own) patch = emptyPlaceFields(event, own);
                else if (venue && (!event.city || !event.region || !event.country) && !isSampleMode()) {
                  try {
                    const found = await canonicalApi.venueLocation(venue);
                    if (found.kind === 'one') patch = emptyPlaceFields(event, found.location);
                    else if (found.kind === 'several') setVenueChoices(found.choices.filter((c) => Object.keys(emptyPlaceFields(event, c)).length));
                  } catch {
                    // No lookup: the venue is saved alone, as before.
                  }
                }
                return save({ venue, ...patch });
              }}
            />
            {venueChoices.length > 0 && (
              <div className="space-y-1">
                {venueChoices.map((c) => (
                  <button
                    key={[c.city, c.region, c.country].join('|')}
                    type="button"
                    onClick={() => {
                      setVenueChoices([]);
                      void save(emptyPlaceFields(event, c));
                    }}
                    className="block text-left text-xs text-accent hover:underline"
                  >
                    Use “{[c.city, c.region, c.country].filter(Boolean).join(', ')}” from venue records
                  </button>
                ))}
              </div>
            )}
            <Field
              label="City"
              field="city"
              value={event.city}
              placeholder="City"
              source={event.sources.city}
              onInferredAct={verifyInferred} inferred={inferred.city}
              suggestions={citySuggestions}
              onType={setCityQuery}
              onSave={(v) => saveCity(v)}
            />
            <Field
              label="State"
              field="region"
              value={event.region}
              placeholder="NV, or the region"
              source={event.sources.region}
              onInferredAct={verifyInferred} inferred={inferred.region}
              offer={
                mapOffer
                  ? { value: mapOffer.value, from: mapOffer.from, onUse: () => void save(mapOffer.patch) }
                  : undefined
              }
              onSave={(v) => save({ region: text(v) })}
            />
            <Field label="Country" field="country" value={event.country} source={event.sources.country} onInferredAct={verifyInferred} inferred={inferred.country} onSave={(v) => save({ country: text(v) })} />
            <div className="col-span-2 space-y-1">
              <span className="block text-[11px] font-semibold text-text-muted">Type</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {(['festival', 'concert'] as const).map((k) => {
                  const shown = event.kind ?? worked.kind;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={shown === k}
                      onClick={() => save({ kind: k })}
                      className={`min-h-11 rounded-control border px-3 text-sm sm:min-h-9 ${shown === k ? 'border-accent bg-accent-tint text-text' : 'border-line-strong text-text-muted hover:border-accent'}`}
                    >
                      {KIND_LABELS[k]}
                    </button>
                  );
                })}
                {!event.kind && worked.kind && (
                  worked.by === 'series' ? (
                    <span
                      title={`${worked.kind === 'festival' ? 'From festival series' : 'From tour series'}. Tap a type to change it.`}
                      className="text-xs text-text-muted"
                    >
                      {worked.kind === 'festival' ? 'From festival series' : 'From tour series'}
                    </span>
                  ) : (
                    <span title="Worked out from the lineup; tap a type to change it." aria-label="Worked out from the lineup" className="text-accent">
                      ✦
                    </span>
                  )
                )}
              </div>
            </div>
          </div>

          {confirmations.length > 0 && (
            <div className="space-y-1 text-xs">
              <p className="inline-flex items-center gap-1 text-good">
                <Check className="h-3.5 w-3.5" /> Date confirmed by {confirmations.length} source{confirmations.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-0.5 text-text-muted">
                {confirmations.map((s, i) => (
                  <li key={i} className="truncate">
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-accent">
                      {SOURCE_LABELS[s.sourceType]}
                      {s.quote && (
                        <>
                          : <q className="font-display text-[13px] italic text-text">{s.quote}</q>
                        </>
                      )}{' '}
                      <ExternalLink className="inline h-2.5 w-2.5" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {details.status === 'none' && <p className="text-xs text-text-muted">No listing found. It's saved as you typed it.</p>}
          {details.status === 'needs_date' && <p className="text-xs text-warn">Add when it was (a year is enough), then look again.</p>}
          {details.status === 'off' && <p className="text-xs text-text-muted">No event source is set up, so details are as you typed them.</p>}
          <Weather event={event} busy={busy === 'weather'} note={weatherNote} onLookUp={lookUpWeather} />
        </section>

        {/* Your details */}
        <details
          id="your-notes"
          open={notesOpen}
          onToggle={(e) => rememberSection('notes', e.currentTarget.open)}
          className={`group ${card}`}
        >
          <summary className={`${cardTitle} flex cursor-pointer list-none items-center justify-between gap-2`}>
            <span className="flex-1">Your night</span>
            {night && <span className="truncate text-sm font-normal text-text-muted">{night}</span>}
            <ChevronDown className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-text-muted">Format</span>
            <ChipInput
              items={formatsOf(event.format)}
              placeholder="Club night, warehouse party, block party…"
              past={formatSuggestions}
              label="Add a format"
              onChange={(formats) => save({ format: joinFormats(formats) })}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-text-muted">Went with</span>
            {event.peopleLocked ? (
              <span className="block rounded-md border border-line px-2.5 py-1.5 text-xs text-warn">🔒 Vault locked</span>
            ) : (
              <ChipInput items={event.companions} placeholder="Add a name" past={pastCompanions} label="Add who you went with" onChange={(companions) => save({ companions })} />
            )}
          </label>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-text-muted">Rating</span>
              <Stars value={event.rating ?? null} onChange={(rating) => save({ rating })} size="md" className="-ml-1.5 flex" />
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
          {((onManage && manageLinks(event).length > 0) || (canManageEdition && event.editionId)) && (
            <p className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3 text-[11px] text-text-muted">
              <FolderCog className="h-3 w-3" /> Edit on every event in Manage:
              {onManage && manageLinks(event).map((m) => (
                <button
                  key={`${m.target.kind}:${m.target.id}`}
                  onClick={() => onManage(m.target)}
                  className="rounded-full border border-line px-2 py-0.5 text-text-muted hover:text-accent"
                >
                  {m.label}
                </button>
              ))}
              {canManageEdition && event.editionId && (
                <a
                  href={editionUrl(event.editionId)}
                  onClick={(e) => {
                    if (isModifiedClick(e)) return;
                    e.preventDefault();
                    const url = editionUrl(event.editionId!);
                    window.history.pushState({ fromManageList: false }, '', url);
                    rememberManageSearch(new URL(url, window.location.origin).search);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }}
                  className="rounded-full border border-line px-2 py-0.5 text-text-muted hover:text-accent"
                >
                  Edition
                </a>
              )}
            </p>
          )}
        </details>

          </div>
          <div className="min-w-0">
          {/* Who you saw and the full lineup share the column as folder tabs joined to their card. */}
          <Tabs
            label="Who you saw and lineup"
            value={rightTab}
            onChange={setRightTab}
            panel="surface-1"
            items={[
              { value: 'seen', label: 'Who you saw', icon: Users, count: event.seen.length },
              { value: 'lineup', label: 'Lineup', icon: ListMusic, ...(edition ? { count: lineupActs.length } : {}) },
            ]}
          />
        {/* Who you saw */}
        <section id="who-you-saw" hidden={rightTab !== 'seen'} className={tabbedCard}>
          <div className="flex items-center justify-between gap-2">
            <h3 className={cardTitle}>
              Who you saw{event.seen.length > 0 && <span className="font-normal text-text-muted"> · {event.seen.length}</span>}
            </h3>
            <SectionHelp label="Who you saw">
              Each act is a row. Tap the row to set its billing, set type and B2B partners. Tap the heart to mark a favourite set. Acts you add here count as seen.
            </SectionHelp>
          </div>
          <SeenActs seen={event.seen} sets={sets} past={pastArtists} pastSets={pastSetsList} inferredBilling={inferredBilling} onChange={(seen) => save({ seen })} />
          <SeenGenres event={event} />
          {offered.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-text-muted">From the event name:</span>
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
                  className="inline-flex items-center gap-1 rounded-full border border-accent-tint-line px-2.5 py-1 text-accent hover:bg-accent-tint"
                >
                  <Plus className="h-3 w-3" /> {s.name} as {roleName(s.role)}?
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Stage 2: the lineup */}
        <section id="lineup" hidden={rightTab !== 'lineup'} className={tabbedCard}>
          <h3 className={`${cardTitle} flex items-baseline gap-1.5`}>
            Full lineup
            {edition && <span className="font-normal text-text-muted">· {lineupActs.length}</span>}
          </h3>
          {!job && !edition && (
            <div className="space-y-2">
              <p className="text-xs text-text-muted">
                Find the lineup looks for who played in Clashfinder, the promoter's page and ticketing listings. It cites every act and never guesses. The link is optional.
              </p>
              <input className={input} value={lineupUrl} onChange={(e) => setLineupUrl(e.target.value)} placeholder="Lineup page, if you know one (optional)" />
            </div>
          )}
          {/* A replacement lookup on a confirmed edition shows its progress too, so it never looks like nothing happened. */}
          {job && (!edition || isActive(job.status) || pendingReplacement(job, edition)) && (
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
          {lineupActs.length > 0 && (() => {
            const lineupSlots = groupReviewSlots(lineupActs.map((p) => ({ ...p, key: p.artistKey })));
            const allStages = Array.from(
              new Set(lineupActs.flatMap((p) => p.stages || []).filter(Boolean)),
            ).sort();
            const allDays = Array.from(
              new Set(lineupActs.flatMap((p) => p.days || []).filter(Boolean)),
            ).sort();

            const matchingSlots = lineupSlots.filter((slot) => {
              if (lineupStage !== 'all') {
                const matchesStage = slot.items.some((it) => it.item.stages?.includes(lineupStage));
                if (!matchesStage) return false;
              }
              if (lineupDay !== 'all' && allDays.includes(lineupDay)) {
                const matchesDay = slot.items.some((it) => it.item.days?.includes(lineupDay));
                if (!matchesDay) return false;
              }
              if (lineupSearch.trim()) {
                const q = lineupSearch.toLowerCase();
                const matchesSearch = slot.items.some((it) => it.item.name.toLowerCase().includes(q));
                if (!matchesSearch) return false;
              }
              return true;
            });
            // A timed lineup reads as a timetable: earliest set first, untimed acts after.
            const slotStart = (slot: (typeof lineupSlots)[number]) =>
              slot.items.map((it) => starts.get(it.item.artistKey)).filter((t): t is string => Boolean(t)).sort()[0];
            const filteredSlots = byStartTime(matchingSlots, slotStart);

            return (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <p className="text-[11px] text-text-muted">
                    From the lineup, tap to mark who you saw
                    {filteredSlots.length !== lineupSlots.length ? ` (${filteredSlots.length} of ${lineupSlots.length})` : ''}:
                  </p>
                </div>

                {(allStages.length > 1 || allDays.length > 1 || lineupSlots.length > 20) && (
                  <div className="space-y-1.5 rounded-lg border border-line bg-surface-1 p-2">
                    {lineupSlots.length > 20 && (
                      <input
                        type="search"
                        value={lineupSearch}
                        onChange={(e) => setLineupSearch(e.target.value)}
                        placeholder="Search acts..."
                        className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs text-text placeholder-text-faint focus:border-accent focus:outline-none"
                      />
                    )}

                    {allDays.length > 1 && (
                      <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-xs">
                        <span className="shrink-0 text-[10px] text-text-muted mr-1">Day:</span>
                        <button
                          type="button"
                          onClick={() => setLineupDay('all')}
                          className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                            lineupDay === 'all'
                              ? 'border-accent-tint-line bg-accent-tint text-text font-medium'
                              : 'border-line bg-surface-1 text-text-muted hover:text-text'
                          }`}
                        >
                          All days
                        </button>
                        {allDays.map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setLineupDay(d)}
                            className={`rounded-md border px-2 py-0.5 text-[11px] shrink-0 transition-colors ${
                              lineupDay === d
                                ? 'border-accent-tint-line bg-accent-tint text-text font-medium'
                                : 'border-line bg-surface-1 text-text-muted hover:text-text'
                            }`}
                          >
                            {whenLabel({ startDate: d }) ?? d}
                          </button>
                        ))}
                      </div>
                    )}

                    {allStages.length > 1 && (
                      <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-xs">
                        <span className="shrink-0 text-[10px] text-text-muted mr-1">Stage:</span>
                        <button
                          type="button"
                          onClick={() => setLineupStage('all')}
                          className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                            lineupStage === 'all'
                              ? 'border-accent-tint-line bg-accent-tint text-text font-medium'
                              : 'border-line bg-surface-1 text-text-muted hover:text-text'
                          }`}
                        >
                          All stages
                        </button>
                        {allStages.map((stage) => {
                          const count = lineupSlots.filter((slot) =>
                            slot.items.some((it) => it.item.stages?.includes(stage)),
                          ).length;
                          return (
                            <button
                              key={stage}
                              type="button"
                              onClick={() => setLineupStage(stage)}
                              className={`rounded-md border px-2 py-0.5 text-[11px] shrink-0 transition-colors ${
                                lineupStage === stage
                                  ? 'border-accent-tint-line bg-accent-tint text-text font-medium'
                                  : 'border-line bg-surface-1 text-text-muted hover:text-text'
                              }`}
                            >
                              {stage} <span className="text-[10px] opacity-70">({count})</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-scroll pr-1">
                  {filteredSlots.length === 0 ? (
                    <p className="py-3 text-xs text-text-muted">No acts match the selected stage or filter.</p>
                  ) : (
                    filteredSlots.map((slot) => {
                    const slotKeys = new Set(slot.items.map((it) => it.item.artistKey));
                    const isSolo = slot.items.length === 1 && (!slot.items[0].item.b2b || slot.items[0].item.b2b.length === 0);
                    const on = isSolo
                      ? event.seen.some((s) => s.key === slot.items[0].item.artistKey && (!s.b2b?.length || s.solo))
                      : slotKeys.size > 0 && [...slotKeys].every((k) => event.seen.some((s) => s.key === k && s.b2b?.some((partner) => slotKeys.has(partner))));
                    const title = [
                      slot.items.some((it) => it.item.billing === 'support') && 'Billed as support',
                      slot.items.some((it) => it.item.billing === 'headliner') && 'Headliner',
                      slot.items.map((it) => sets.get(it.item.artistKey)).filter(Boolean).join(' · '),
                    ].filter(Boolean).join(' · ') || undefined;

                    return (
                      <button
                        key={slot.id}
                        onClick={() => {
                          if (on) {
                            if (isSolo) {
                              const artistKey = slot.items[0].item.artistKey;
                              const nextSeen: SeenPatch = [];
                              for (const s of event.seen) {
                                if (s.key === artistKey && (!s.b2b?.length || !s.b2b)) continue;
                                if (s.key === artistKey && s.solo) {
                                  const { solo: _s, soloSet: _ss, ...rest } = s;
                                  nextSeen.push(rest as SeenPatch[number]);
                                  continue;
                                }
                                nextSeen.push(s as SeenPatch[number]);
                              }
                              save({ seen: toPatch(nextSeen as any) });
                            } else {
                              const nextSeen = event.seen.filter(
                                (s) => !(slotKeys.has(s.key) && s.b2b?.some((partner) => slotKeys.has(partner))),
                              );
                              save({ seen: toPatch(nextSeen) });
                            }
                          } else {
                            if (isSolo) {
                              const p = slot.items[0].item;
                              save({
                                seen: [
                                  ...toPatch(event.seen),
                                  {
                                    name: p.name,
                                    from: 'lineup' as const,
                                    role: p.billing,
                                    roleFrom: p.billing ? ('lineup' as const) : undefined,
                                  },
                                ],
                              });
                            } else {
                              const newActs = slot.items.map((it) => {
                                const p = it.item;
                                const partners = slot.items
                                  .filter((other) => other.item.artistKey !== p.artistKey)
                                  .map((other) => other.item.artistKey);
                                return {
                                  name: p.name,
                                  from: 'lineup' as const,
                                  role: p.billing,
                                  roleFrom: p.billing ? ('lineup' as const) : undefined,
                                  slotId: p.slotId,
                                  alias: p.alias,
                                  b2b: partners,
                                };
                              });
                              save({
                                seen: [...toPatch(event.seen), ...newActs],
                              });
                            }
                          }
                        }}
                        title={title}
                        className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-accent bg-accent-tint text-text' : 'border-line text-text-muted hover:text-text'}`}
                      >
                        {slot.name}
                        {slot.items.some((it) => it.item.billing === 'support') && (
                          <span className="ml-1 text-[10px] text-text-muted">support</span>
                        )}
                        {(() => {
                          const t = slot.items.map((it) => chipTimes.get(it.item.artistKey)).find(Boolean);
                          return t ? <span className="ml-1.5 text-[10px] tabular-nums text-text-muted">{t}</span> : null;
                        })()}
                      </button>
                    );
                  })
                )}
                </div>
              </div>
            );
          })()}

          {(!job || edition || job.status === 'no_data' || job.status === 'failed') && !isActive(job?.status) && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                {edition && job ? (
                  <Button onClick={() => setReviewing(true)}>Edit lineup</Button>
                ) : (
                  <span />
                )}
                <Button
                  className="ml-auto"
                  onClick={() => run('lineup', async () => (await eventsApi.findLineup(event.id, lineupUrl || undefined)).event)}
                  disabled={busy === 'lineup' || !(event.year || event.startDate)}
                >
                  {busy === 'lineup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  {job ? 'Look up the lineup again' : 'Find the lineup'}
                </Button>
              </div>
              {!(event.year || event.startDate) && <p className="text-xs text-warn">Add when it was first, then find the lineup.</p>}
            </div>
          )}

          {(event.year || event.startDate) && (
            <div className="mt-2">
              <VersionPicker
                load={async () => eventsApi.lineupVersions(event.id)}
                confirmedActs={edition ? lineupActs.length : undefined}
                busy={busy === 'lineup'}
                onPick={(v, replace) => void run('lineup', async () => (await eventsApi.findLineup(event.id, v.url, replace)).event)}
              />
            </div>
          )}

          {isOwner && event.startDate && !isActive(job?.status) && (
            <div className="mt-2">
              <PasteSetTimes
                startDate={event.startDate}
                endDate={event.endDate}
                busy={busy === 'lineup'}
                onSubmit={(url, text) => void run('lineup', async () => (await eventsApi.pasteSetTimes(event.id, url, text)).event)}
              />
            </div>
          )}

          {edition && (
            <p className="text-[11px] text-text-muted">
              {lineupActs.length} acts confirmed, each with a source.
              {canManageEdition && event.editionId && (
                <>
                  {' · '}
                  <a
                    href={editionUrl(event.editionId)}
                    onClick={(e) => {
                      if (isModifiedClick(e)) return;
                      e.preventDefault();
                      const url = editionUrl(event.editionId!);
                      window.history.pushState({ fromManageList: false }, '', url);
                      rememberManageSearch(new URL(url, window.location.origin).search);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                    className="text-accent hover:underline"
                  >
                    View in Global Archive
                  </a>
                </>
              )}
            </p>
          )}
          {!edition && event.editionId && canManageEdition && (
            <p className="text-[11px] text-text-muted">
              <a
                href={editionUrl(event.editionId)}
                onClick={(e) => {
                  if (isModifiedClick(e)) return;
                  e.preventDefault();
                  const url = editionUrl(event.editionId!);
                  window.history.pushState({ fromManageList: false }, '', url);
                  rememberManageSearch(new URL(url, window.location.origin).search);
                  window.dispatchEvent(new PopStateEvent('popstate'));
                }}
                className="text-accent hover:underline"
              >
                View in Global Archive
              </a>
            </p>
          )}
        </section>

          </div>
        </div>

        <div className="flex items-center justify-between border-t border-line pt-4">
          <div className="flex items-center gap-4">
            {onOpenHistory && (
              <button onClick={() => onOpenHistory(event.id)} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-accent">
                <History className="h-3.5 w-3.5" /> History
              </button>
            )}
            <button
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-bad"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete event
            </button>
          </div>
        </div>
        </EditionIdContext.Provider>
      </FlashContext.Provider>

      {confirmingDelete && (
        <Confirm
          title="Delete event"
          message={`"${eventTitle(event)}" moves to Recently deleted in the Log, where you can restore it for 90 days.`}
          confirmLabel="Delete event"
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
            if (updated) onChange(updated);
            void load();
          }}
        />
      )}
    </DetailShell>
  );
};
