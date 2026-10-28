import React, { useMemo, useState } from 'react';
import { ArrowLeft, GitMerge, Loader2, Plus, Table2, X } from 'lucide-react';
import { entitiesApi, LoggedEvent } from '../services/lineupApi';
import type { Entity, HistoryEntry, LinkRole } from '../server/entities/types';
import { whenLabel } from '../services/format';
import { norm } from '../services/listImport';
import { EventTitle } from './EventTitle';
import { personParts } from '../services/people';
import { entityLabel, KINDS, ManageData } from './ManageView';

// One record in the Manage tab: its events, Rename everywhere, Merge into
// another, AKAs, and its links (a venue's place, a series' hosts).

interface ManageEntryProps {
  entity: Entity;
  data: ManageData;
  events: LoggedEvent[]; // the events pointing at it
  duplicates: Entity[]; // look-alike records, offered to merge
  onBack: () => void;
  onOpen: (id: string) => void; // another record
  onOpenEvent: (id: string) => void;
  onOpenTable: (query: string) => void;
  onChanged: (entry: HistoryEntry, eventsToo?: boolean) => Promise<void>;
}

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';
const primary =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40';
const quiet = 'inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-500';

type Conflict = { message: string; with?: { id: string; name: string } };

// Live records of a kind to pick from by typing: the closest few.
const Picker: React.FC<{
  options: Entity[];
  placeholder: string;
  label: string;
  onPick: (e: Entity) => void;
}> = ({ options, placeholder, label, onPick }) => {
  const [q, setQ] = useState('');
  const key = norm(q);
  const shown = key ? options.filter((o) => norm(entityLabel(o)).includes(key)).slice(0, 8) : [];
  return (
    <div className="space-y-1">
      <input className={control} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={label} />
      {shown.length > 0 && (
        <ul className="rounded-lg border border-zinc-800 bg-zinc-900/60">
          {shown.map((o) => (
            <li key={o.id}>
              <button
                onClick={() => {
                  setQ('');
                  onPick(o);
                }}
                className="w-full px-2.5 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800"
              >
                {entityLabel(o)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const ManageEntry: React.FC<ManageEntryProps> = ({
  entity,
  data,
  events,
  duplicates,
  onBack,
  onOpen,
  onOpenEvent,
  onOpenTable,
  onChanged,
}) => {
  const [name, setName] = useState(entity.kind === 'place' ? String(entity.attrs.city ?? entity.name) : entity.name);
  const [aka, setAka] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Conflict | null>(null);
  const [merging, setMerging] = useState<Entity | null>(null);
  const meta = KINDS.find((k) => k.kind === entity.kind)!;
  const byId = useMemo(() => new Map(data.entities.map((e) => [e.id, e])), [data]);
  const live = (kind: Entity['kind']) => data.entities.filter((e) => e.kind === kind && !e.mergedIntoId);
  const akas = data.aliases.filter((a) => a.entityId === entity.id).map((a) => a.aliasNormalized).sort();
  const sorted = [...events].sort((a, b) => (b.startDate ?? String(b.year ?? '')).localeCompare(a.startDate ?? String(a.year ?? '')));

  const run = async (what: string, fn: () => Promise<HistoryEntry>, after?: (entry: HistoryEntry) => void) => {
    setBusy(what);
    setProblem(null);
    try {
      const entry = await fn();
      await onChanged(entry);
      after?.(entry);
    } catch (err) {
      const conflict = (err as { conflict?: { id: string; name: string } }).conflict;
      setProblem({ message: err instanceof Error ? err.message : String(err), with: conflict });
    } finally {
      setBusy(null);
    }
  };

  const current = entity.kind === 'place' ? String(entity.attrs.city ?? entity.name) : entity.name;
  const renamed = name.trim() && name.trim() !== current;
  const merge = (into: Entity) =>
    run('merge', () => entitiesApi.merge(entity.id, into.id), () => {
      setMerging(null);
      onOpen(into.id);
    });
  const link = (to: Entity, role: LinkRole, add: boolean) =>
    run(`link:${to.id}`, () => (add ? entitiesApi.link(entity.id, to.id, role) : entitiesApi.unlink(entity.id, to.id, role)));

  const place = entity.kind === 'venue' ? data.links.find((l) => l.fromId === entity.id && l.role === 'in') : undefined;
  const hosts = data.links.filter((l) => l.fromId === entity.id && l.role === 'hosted_by').map((l) => byId.get(l.toId)!).filter(Boolean);
  const hosted = data.links.filter((l) => l.toId === entity.id && l.role === 'hosted_by').map((l) => byId.get(l.fromId)!).filter(Boolean);
  const venuesHere = data.links.filter((l) => l.toId === entity.id && l.role === 'in').map((l) => byId.get(l.fromId)!).filter(Boolean);
  const tableQuery =
    entity.kind === 'artist'
      ? `artist=${encodeURIComponent(entity.nameNormalized)}`
      : entity.kind === 'venue'
        ? `venue=${encodeURIComponent(entity.name)}`
        : entity.kind === 'series'
          ? `series=${encodeURIComponent(entity.name)}`
          : entity.kind === 'person'
            ? `with=${encodeURIComponent(entity.name)}`
            : null;

  return (
    <section className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">
        <ArrowLeft className="h-3.5 w-3.5" /> All {meta.label.toLowerCase()}
      </button>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold text-zinc-50">{entityLabel(entity)}</h2>
          <p className="text-xs text-zinc-500">
            {meta.one}
            {entity.kind !== 'organization' && ` · ${events.length} event${events.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {tableQuery && events.length > 0 && (
          <button onClick={() => onOpenTable(tableQuery)} className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-400 hover:text-violet-300">
            <Table2 className="h-3.5 w-3.5" /> In the Table
          </button>
        )}
      </div>

      {problem && (
        <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-950/30 p-2.5 text-sm text-rose-200">
          <p>{problem.message}</p>
          {problem.with && (
            <button onClick={() => setMerging(byId.get(problem.with!.id) ?? null)} className={quiet}>
              <GitMerge className="h-3.5 w-3.5" /> Merge into “{problem.with.name}”
            </button>
          )}
        </div>
      )}

      {entity.kind === 'person' && <PersonDetails entity={entity} events={events.length} busy={busy} run={run} />}

      <div className={`space-y-1.5 ${entity.kind === 'person' ? 'hidden' : ''}`}>
        <h3 className={sectionTitle}>{entity.kind === 'place' ? 'City' : 'Name'}</h3>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (renamed) void run('rename', () => entitiesApi.rename(entity.id, name.trim()));
          }}
        >
          <input className={control} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <button type="submit" disabled={!renamed || Boolean(busy)} className={primary}>
            {busy === 'rename' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Rename everywhere
          </button>
        </form>
        {renamed && entity.kind !== 'organization' && (
          <p className="text-xs text-zinc-500">
            Changes it on {events.length} event{events.length === 1 ? '' : 's'}
            {entity.kind !== 'place' && <>; “{current}” is kept as an AKA</>}.
          </p>
        )}
      </div>

      {entity.kind !== 'place' && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Also known as</h3>
          {akas.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {akas.map((a) => (
                <li key={a} className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                  {a}
                  <button
                    onClick={() => void run(`aka:${a}`, () => entitiesApi.removeAlias(entity.id, a))}
                    disabled={Boolean(busy)}
                    className="text-zinc-500 hover:text-rose-300"
                    aria-label={`Remove AKA ${a}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (aka.trim()) void run('aka', () => entitiesApi.addAlias(entity.id, aka.trim()), () => setAka(''));
            }}
          >
            <input className={control} value={aka} onChange={(e) => setAka(e.target.value)} placeholder="Another name or spelling" aria-label="Add an AKA" />
            <button type="submit" disabled={!aka.trim() || Boolean(busy)} className={quiet}>
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          </form>
          <p className="text-xs text-zinc-500">Typed on an event, an AKA is found as this {meta.one}.</p>
        </div>
      )}

      {entity.kind === 'venue' && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Place</h3>
          {place && byId.get(place.toId) ? (
            <p className="flex items-center gap-2 text-sm text-zinc-200">
              <button onClick={() => onOpen(place.toId)} className="hover:text-violet-300">
                {entityLabel(byId.get(place.toId)!)}
              </button>
              <button
                onClick={() => void link(byId.get(place.toId)!, 'in', false)}
                disabled={Boolean(busy)}
                className="text-zinc-500 hover:text-rose-300"
                aria-label="Remove the place"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </p>
          ) : (
            <p className="text-xs text-zinc-500">Not set.</p>
          )}
          <Picker options={live('place')} placeholder={place ? 'Move to another place…' : 'Find the city…'} label="Pick a place" onPick={(p) => void link(p, 'in', true)} />
        </div>
      )}

      {entity.kind === 'place' && venuesHere.length > 0 && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Venues here</h3>
          <ul className="flex flex-wrap gap-1.5">
            {venuesHere.map((v) => (
              <li key={v.id}>
                <button onClick={() => onOpen(v.id)} className="rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:text-violet-300">
                  {v.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {entity.kind === 'series' && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Hosted by</h3>
          {hosts.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {hosts.map((o) => (
                <li key={o.id} className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                  <button onClick={() => onOpen(o.id)} className="hover:text-violet-300">
                    {o.name}
                  </button>
                  <button
                    onClick={() => void link(o, 'hosted_by', false)}
                    disabled={Boolean(busy)}
                    className="text-zinc-500 hover:text-rose-300"
                    aria-label={`Remove host ${o.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">Not set. Add organizations in the Organizations list first.</p>
          )}
          <Picker
            options={live('organization').filter((o) => !hosts.includes(o))}
            placeholder="Find an organization…"
            label="Add a host"
            onPick={(o) => void link(o, 'hosted_by', true)}
          />
        </div>
      )}

      {entity.kind === 'organization' && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Hosts</h3>
          {hosted.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {hosted.map((s) => (
                <li key={s.id}>
                  <button onClick={() => onOpen(s.id)} className="rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:text-violet-300">
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">No series yet. Open a series and add this organization under Hosted by.</p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <h3 className={sectionTitle}>Merge</h3>
        {duplicates.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-amber-300">
            Looks like:
            {duplicates.map((d) => (
              <button key={d.id} onClick={() => setMerging(d)} className="rounded-full border border-amber-500/30 px-2 py-0.5 hover:bg-amber-950/40">
                {entityLabel(d)}
              </button>
            ))}
          </p>
        )}
        {merging ? (
          <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-950/20 p-2.5 text-sm text-zinc-200">
            <p>
              Merge “{entityLabel(entity)}” into “{entityLabel(merging)}”? Its {events.length} event{events.length === 1 ? '' : 's'} will show “
              {entityLabel(merging)}”{entity.kind !== 'place' && <>, and “{entity.name}” becomes an AKA</>}. You can undo it.
            </p>
            <div className="flex gap-2">
              <button onClick={() => void merge(merging)} disabled={Boolean(busy)} className={primary}>
                {busy === 'merge' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />} Merge
              </button>
              <button onClick={() => setMerging(null)} className={quiet}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <Picker
            options={live(entity.kind).filter((e) => e.id !== entity.id)}
            placeholder={`The ${meta.one} this is the same as…`}
            label="Merge into"
            onPick={setMerging}
          />
        )}
      </div>

      {entity.kind !== 'organization' && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Events</h3>
          {sorted.length ? (
            <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900">
              {sorted.map((e) => (
                <li key={e.id}>
                  <button onClick={() => onOpenEvent(e.id)} className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-sm hover:bg-zinc-900/60">
                    <span className="w-28 shrink-0 text-xs tabular-nums text-zinc-500">{whenLabel(e) ?? 'Date unknown'}</span>
                    <span className="min-w-0 truncate text-zinc-200">
                      <EventTitle event={e} />
                      {e.venue && entity.kind !== 'venue' && <span className="text-zinc-600"> · {e.venue}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">No events point at it now.</p>
          )}
        </div>
      )}
    </section>
  );
};

// A person's first and last name and your note. Saving a new name renames
// them on every event, keeping the old name as an AKA.
const PersonDetails: React.FC<{
  entity: Entity;
  events: number;
  busy: string | null;
  run: (what: string, fn: () => Promise<HistoryEntry>) => Promise<void>;
}> = ({ entity, events, busy, run }) => {
  const parts = personParts(entity.name, entity.attrs);
  const savedNote = typeof entity.attrs.note === 'string' ? entity.attrs.note : '';
  const [first, setFirst] = useState(parts.first);
  const [last, setLast] = useState(parts.last ?? '');
  const [note, setNote] = useState(savedNote);
  const name = [first.trim(), last.trim()].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const set = typeof entity.attrs.first === 'string';
  const changed = !set || name !== entity.name || note.trim() !== savedNote;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (first.trim() && changed) void run('person', () => entitiesApi.updatePerson(entity.id, { first, last, note }));
      }}
    >
      <h3 className={sectionTitle}>Name</h3>
      <div className="grid grid-cols-2 gap-2">
        <input className={control} value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First name" aria-label="First name" />
        <input className={control} value={last} onChange={(e) => setLast(e.target.value)} placeholder="Last name (optional)" aria-label="Last name" />
      </div>
      <textarea
        className={`${control} min-h-[4rem]`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        placeholder="A note about them (how you met, what they like)"
        aria-label="Note"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!first.trim() || !changed || Boolean(busy)} className={primary}>
          {busy === 'person' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
        </button>
        {name && name !== entity.name && (
          <p className="text-xs text-zinc-500">
            Shows as “{name}” on {events} event{events === 1 ? '' : 's'}; “{entity.name}” is kept as an AKA.
          </p>
        )}
      </div>
    </form>
  );
};
