import React, { useMemo, useState, useEffect } from 'react';
import { ArrowLeft, GitMerge, Plus, Sparkles, Table2, X } from 'lucide-react';
import { entitiesApi, collaborationsApi, genresApi, type CollaborationItem, type GenresList, LoggedEvent } from '../services/lineupApi';
import { genresByArtist } from '../services/genres';
import type { Entity, HistoryEntry, LinkRole } from '../server/entities/types';
import { whenLabel } from '../services/format';
import { norm } from '../services/listImport';
import { normalizeName } from '../server/lineup/text';
import { Equalizer } from './ui/Equalizer';
import { Ledger } from './ui/Ledger';
import { Pill } from './ui/Pill';
import { EventTitle } from './EventTitle';
import { personParts } from '../services/people';
import { attrFields } from '../server/entities/attrs';
import { categoryGaps, LABELLED, linkedSuggestions } from '../services/dataHealth';
import { artistGaps, personGenreGroups, personInsights, seriesStreak, spanLabel } from '../services/insights';
import { wentTo } from '../server/events/attendance';
import { entityLabel, KINDS, ManageData } from './ManageView';
import { ArtistGenresEditor } from './ArtistGenresEditor';
import { buildManageUrl, isModifiedClick } from '../services/manageNav';

// One record in the Manage tab: its events, Rename everywhere, Merge into
// another, AKAs, and its links (a venue's place, a series' hosts).

interface ManageEntryProps {
  entity: Entity;
  data: ManageData;
  events: LoggedEvent[]; // the events pointing at it
  allEvents: LoggedEvent[]; // every event, for insights across them
  duplicates: Entity[]; // look-alike records, offered to merge
  onBack: () => void;
  onOpen: (id: string) => void; // another record
  onOpenEvent: (id: string) => void;
  onOpenTable: (query: string) => void;
  onChanged: (entry: HistoryEntry, eventsToo?: boolean) => Promise<void>;
}

const control =
  'min-h-11 sm:min-h-9 w-full rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';
const primary =
  'inline-flex min-h-11 sm:min-h-9 shrink-0 items-center gap-1.5 rounded-control bg-accent-fill px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40';
const quiet = 'inline-flex min-h-11 sm:min-h-9 shrink-0 items-center gap-1 rounded-control border border-line-strong px-2.5 py-1.5 text-sm text-text-muted hover:text-text disabled:opacity-40';
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';

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
        <ul className="rounded-card border border-line bg-surface-1">
          {shown.map((o) => (
            <li key={o.id}>
              <button
                onClick={() => {
                  setQ('');
                  onPick(o);
                }}
                className="min-h-11 w-full px-2.5 py-1.5 text-left text-sm text-text hover:bg-surface-2 sm:min-h-9"
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
  allEvents,
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

  const [collabs, setCollabs] = useState<CollaborationItem[]>([]);
  useEffect(() => {
    if (entity.kind === 'artist') {
      collaborationsApi.list().then(setCollabs).catch(() => undefined);
    }
  }, [entity.kind, entity.id]);

  const artistCollabs = useMemo(() => {
    if (entity.kind !== 'artist') return [];
    const normName = entity.nameNormalized;
    return collabs.filter((c) => c.partners.some((p) => normalizeName(p) === normName));
  }, [collabs, entity.kind, entity.nameNormalized]);

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
  const labelled = data.links.filter((l) => l.toId === entity.id && l.role === 'has_label').map((l) => byId.get(l.fromId)!).filter(Boolean);
  const venuesHere = data.links.filter((l) => l.toId === entity.id && l.role === 'in').map((l) => byId.get(l.fromId)!).filter(Boolean);
  // The header counts only events you went to, like the Table it links to.
  const wentCount = wentTo(events, new Date().toISOString().slice(0, 10)).length;
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
      <a
        href={buildManageUrl({ scope: 'mine', kind: entity.kind })}
        onClick={(e) => {
          if (isModifiedClick(e)) return;
          e.preventDefault();
          onBack();
        }}
        className="inline-flex min-h-11 items-center gap-1 text-xs text-text-muted hover:text-text sm:min-h-9"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All {meta.label.toLowerCase()}
      </a>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-2xl font-normal text-text">{entityLabel(entity)}</h2>
          <p className="font-mono text-xs tabular-nums text-text-muted">
            {meta.one}
            {entity.kind !== 'organization' && ` · ${wentCount} event${wentCount === 1 ? '' : 's'}`}
          </p>
        </div>
        {tableQuery && events.length > 0 && (
          <button onClick={() => onOpenTable(tableQuery)} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control px-1.5 text-xs text-text-muted hover:text-accent sm:min-h-9">
            <Table2 className="h-3.5 w-3.5" /> In the Table
          </button>
        )}
      </div>

      {problem && (
        <div className="space-y-2 rounded-card border border-line bg-bad-soft p-2.5 text-sm text-text">
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
            {busy === 'rename' && <Equalizer size="sm" />} Rename everywhere
          </button>
        </form>
        {renamed && entity.kind !== 'organization' && (
          <p className="text-xs text-text-muted">
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
                <li key={a} className="inline-flex items-center gap-1 rounded-full border border-transparent bg-neutral-soft px-2 py-0.5 text-xs text-text-muted">
                  {a}
                  <button
                    onClick={() => void run(`aka:${a}`, () => entitiesApi.removeAlias(entity.id, a))}
                    disabled={Boolean(busy)}
                    className="text-text-muted hover:text-bad"
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
          <p className="text-xs text-text-muted">Typed on an event, an AKA is found as this {meta.one}.</p>
        </div>
      )}

      {entity.kind === 'artist' && (
        <ArtistGenresEditor
          actKey={
            events.flatMap((e) => e.seen).find((s) => s.artistId === entity.id || s.key === entity.nameNormalized)?.key ??
            entity.nameNormalized
          }
        />
      )}

      {entity.kind === 'artist' && artistCollabs.length > 0 && (
        <div className="space-y-2">
          <h3 className={sectionTitle}>Collaborative Projects</h3>
          <div className="space-y-1.5">
            {artistCollabs.map((c) => {
              const otherPartners = c.partners.filter((p) => normalizeName(p) !== entity.nameNormalized);
              return (
                <div
                  key={c.aliasNormalized}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface-1 p-2.5"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text">{c.alias}</span>
                      <Pill tone="accent">Collaboration</Pill>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
                      <span>with</span>
                      {otherPartners.map((partner) => {
                        const partnerEntity = data.entities.find(
                          (e) => e.kind === 'artist' && !e.mergedIntoId && e.nameNormalized === normalizeName(partner),
                        );
                        return partnerEntity ? (
                          <button
                            key={partner}
                            type="button"
                            onClick={() => onOpen(partnerEntity.id)}
                            className="inline-flex text-accent hover:underline"
                          >
                            <Pill tone="neutral">{partner}</Pill>
                          </button>
                        ) : (
                          <Pill key={partner} tone="neutral">{partner}</Pill>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {entity.kind === 'venue' && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Place</h3>
          {place && byId.get(place.toId) ? (
            <p className="flex items-center gap-2 text-sm text-text">
              <button onClick={() => onOpen(place.toId)} className="hover:text-accent">
                {entityLabel(byId.get(place.toId)!)}
              </button>
              <button
                onClick={() => void link(byId.get(place.toId)!, 'in', false)}
                disabled={Boolean(busy)}
                className="text-text-muted hover:text-bad"
                aria-label="Remove the place"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </p>
          ) : (
            <p className="text-xs text-text-muted">Not set.</p>
          )}
          <Picker options={live('place')} placeholder={place ? 'Move to another place…' : 'Find the city…'} label="Pick a place" onPick={(p) => void link(p, 'in', true)} />
        </div>
      )}

      {(entity.kind === 'artist' || entity.kind === 'person' || entity.kind === 'series') && (
        <Insights entity={entity} data={data} events={events} allEvents={allEvents} busy={busy} onOpen={onOpen} onOpenEvent={onOpenEvent} link={link} />
      )}

      {LABELLED.includes(entity.kind) && (
        <Labels entity={entity} data={data} events={events} busy={busy} onOpen={onOpen} link={(l, add) => link(l, 'has_label', add)} />
      )}

      {entity.kind === 'label' && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>On</h3>
          {labelled.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {labelled.map((r) => (
                <li key={r.id}>
                  <button onClick={() => onOpen(r.id)} className="rounded-full border border-transparent bg-neutral-soft px-2 py-0.5 text-xs text-text-muted hover:bg-accent-tint">
                    {r.name} <span className="text-text-muted">{r.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-muted">Not on any venue or series yet. Add it from a venue's or series' page.</p>
          )}
        </div>
      )}

      {attrFields(entity.kind).length > 0 && entity.kind !== 'person' && <Details key={entity.updatedAt} entity={entity} busy={busy} run={run} />}

      {entity.kind === 'place' && venuesHere.length > 0 && (
        <div className="space-y-1.5">
          <h3 className={sectionTitle}>Venues here</h3>
          <ul className="flex flex-wrap gap-1.5">
            {venuesHere.map((v) => (
              <li key={v.id}>
                <button onClick={() => onOpen(v.id)} className="rounded-full border border-transparent bg-neutral-soft px-2 py-0.5 text-xs text-text-muted hover:bg-accent-tint">
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
                <li key={o.id} className="inline-flex items-center gap-1 rounded-full border border-transparent bg-neutral-soft px-2 py-0.5 text-xs text-text-muted">
                  <button onClick={() => onOpen(o.id)} className="hover:text-accent">
                    {o.name}
                  </button>
                  <button
                    onClick={() => void link(o, 'hosted_by', false)}
                    disabled={Boolean(busy)}
                    className="text-text-muted hover:text-bad"
                    aria-label={`Remove host ${o.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-muted">Not set. Add organizations in the Organizations list first.</p>
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
                  <button onClick={() => onOpen(s.id)} className="rounded-full border border-transparent bg-neutral-soft px-2 py-0.5 text-xs text-text-muted hover:bg-accent-tint">
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-muted">No series yet. Open a series and add this organization under Hosted by.</p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <h3 className={sectionTitle}>Merge</h3>
        {duplicates.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-warn">
            Looks like:
            {duplicates.map((d) => (
              <button key={d.id} onClick={() => setMerging(d)} className="rounded-full bg-warn-soft px-2 py-0.5 text-text hover:bg-row-hover">
                {entityLabel(d)}
              </button>
            ))}
          </p>
        )}
        {merging ? (
          <div className="space-y-2 rounded-card border border-line bg-accent-tint p-2.5 text-sm text-text">
            <p>
              Merge “{entityLabel(entity)}” into “{entityLabel(merging)}”? Its {events.length} event{events.length === 1 ? '' : 's'} will show “
              {entityLabel(merging)}”{entity.kind !== 'place' && <>, and “{entity.name}” becomes an AKA</>}. You can undo it.
            </p>
            <div className="flex gap-2">
              <button onClick={() => void merge(merging)} disabled={Boolean(busy)} className={primary}>
                {busy === 'merge' ? <Equalizer size="sm" /> : <GitMerge className="h-3.5 w-3.5" />} Merge
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
            <Ledger>
              {sorted.map((e) => (
                <Ledger.Row key={e.id} edge="none" onOpen={() => onOpenEvent(e.id)} className="min-h-11 px-3 py-2 text-sm sm:min-h-9">
                  <span className="w-28 shrink-0 font-mono text-xs tabular-nums text-text-muted">{whenLabel(e) ?? 'Date unknown'}</span>
                  <span className="min-w-0 truncate text-text">
                    <EventTitle event={e} />
                    {e.venue && entity.kind !== 'venue' && <span className="text-text-muted"> · {e.venue}</span>}
                  </span>
                </Ledger.Row>
              ))}
            </Ledger>
          ) : (
            <p className="text-xs text-text-muted">No events point at it now.</p>
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
          {busy === 'person' && <Equalizer size="sm" />} Save
        </button>
        {name && name !== entity.name && (
          <p className="text-xs text-text-muted">
            Shows as “{name}” on {events} event{events === 1 ? '' : 's'}; “{entity.name}” is kept as an AKA.
          </p>
        )}
      </div>
    </form>
  );
};

// A record's details in your words (attrs.ts lists them per kind).
const Details: React.FC<{
  entity: Entity;
  busy: string | null;
  run: (what: string, fn: () => Promise<HistoryEntry>) => Promise<void>;
}> = ({ entity, busy, run }) => {
  const fields = attrFields(entity.kind);
  const saved = (key: string) => (typeof entity.attrs[key] === 'string' ? (entity.attrs[key] as string) : '');
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, saved(f.key)])));
  const changed = fields.some((f) => values[f.key].trim() !== saved(f.key));
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) void run('details', () => entitiesApi.updateAttrs(entity.id, values));
      }}
    >
      <h3 className={sectionTitle}>Details</h3>
      {fields.map((f) => (
        <label key={f.key} className="block space-y-1">
          <span className="text-xs text-text-muted">{f.label}</span>
          {f.multiline ? (
            <textarea
              className={`${control} min-h-[4rem]`}
              value={values[f.key]}
              maxLength={f.max}
              placeholder={f.placeholder}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          ) : (
            <input
              className={control}
              value={values[f.key]}
              maxLength={f.max}
              placeholder={f.placeholder}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <button type="submit" disabled={!changed || Boolean(busy)} className={primary}>
        {busy === 'details' && <Equalizer size="sm" />} Save details
      </button>
    </form>
  );
};

// A venue's or series' labels, picked from your list: one per group, the
// groups other records of this kind use offered as gaps, and labels the
// linked series or venues have offered in one tap.
const Labels: React.FC<{
  entity: Entity;
  data: ManageData;
  events: LoggedEvent[];
  busy: string | null;
  onOpen: (id: string) => void;
  link: (label: Entity, add: boolean) => Promise<void>;
}> = ({ entity, data, events, busy, onOpen, link }) => {
  const byId = new Map(data.entities.map((e) => [e.id, e]));
  const mine = data.links
    .filter((l) => l.fromId === entity.id && l.role === 'has_label')
    .map((l) => byId.get(l.toId))
    .filter((l): l is Entity => Boolean(l));
  const all = data.entities.filter((e) => e.kind === 'label' && !e.mergedIntoId);
  const input = { entities: data.entities, links: data.links, events };
  const gaps = categoryGaps(input).filter((g) => g.kind === entity.kind && g.missing.some((m) => m.id === entity.id));
  const offers = linkedSuggestions(input).filter((o) => o.recordId === entity.id);
  const group = (l: Entity) => (typeof l.attrs.group === 'string' ? l.attrs.group : '');
  return (
    <div className="space-y-1.5">
      <h3 className={sectionTitle}>Labels</h3>
      {mine.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {mine.map((l) => (
            <li key={l.id} className="inline-flex items-center gap-1 rounded-full border border-transparent bg-neutral-soft px-2 py-0.5 text-xs text-text-muted">
              <button onClick={() => onOpen(l.id)} className="hover:text-accent" title={group(l) || undefined}>
                {l.name}
              </button>
              <button onClick={() => void link(l, false)} disabled={Boolean(busy)} className="text-text-muted hover:text-bad" aria-label={`Remove label ${l.name}`}>
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {offers.map((o) => {
        const label = byId.get(o.labelId);
        const because = byId.get(o.becauseId);
        if (!label || !because) return null;
        return (
          <p key={o.labelId} className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            {because.name} is {label.name}.
            <button onClick={() => void link(label, true)} disabled={Boolean(busy)} className="rounded-full bg-accent-tint px-2 py-0.5 text-text hover:bg-row-hover">
              Add {label.name}
            </button>
          </p>
        );
      })}
      {gaps.map((g) => (
        <p key={g.group} className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
          Set {g.group.toLowerCase()}:
          {g.labels.map((l) => (
            <button key={l.id} onClick={() => void link(l, true)} disabled={Boolean(busy)} className="rounded-full bg-neutral-soft px-2 py-0.5 text-text hover:bg-accent-tint">
              {l.name}
            </button>
          ))}
        </p>
      ))}
      {all.length ? (
        <Picker options={all.filter((l) => !mine.includes(l))} placeholder="Add a label…" label="Add a label" onPick={(l) => void link(l, true)} />
      ) : (
        <p className="text-xs text-text-muted">No labels yet. Add them in the Labels list (for example Indoor and Outdoor, group Indoor/Outdoor).</p>
      )}
    </div>
  );
};

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

// Worked out from the events you went to (src/services/insights.ts): for an
// artist the gap since you last saw them and your longest wait, and who
// introduced you; for a person your shows together, the first, the acts you
// saw only with them, and who they introduced you to; for a series the
// editions you went to and your streaks.
const Insights: React.FC<{
  entity: Entity;
  data: ManageData;
  events: LoggedEvent[];
  allEvents: LoggedEvent[];
  busy: string | null;
  onOpen: (id: string) => void;
  onOpenEvent: (id: string) => void;
  link: (to: Entity, role: LinkRole, add: boolean) => Promise<void>;
}> = ({ entity, data, events, allEvents, busy, onOpen, onOpenEvent, link }) => {
  const today = new Date().toISOString().slice(0, 10);
  const [genreData, setGenreData] = useState<Pick<GenresList, 'genres' | 'vocabulary' | 'map'> | null>(null);
  useEffect(() => {
    if (entity.kind !== 'person') return;
    let live = true;
    genresApi
      .list()
      .then((r) => {
        if (live) setGenreData({ genres: r.genres, vocabulary: r.vocabulary, map: r.map });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [entity.kind, entity.id]);
  const byArtist = useMemo(
    () => (genreData ? genresByArtist(genreData.genres, genreData.vocabulary, genreData.map) : new Map()),
    [genreData],
  );
  const byId = new Map(data.entities.map((e) => [e.id, e]));
  const went = wentTo(events, today);
  const chipClass = 'inline-flex items-center gap-1 rounded-full border border-transparent bg-neutral-soft px-2 py-0.5 text-xs text-text-muted';
  const lines: React.ReactNode[] = [];

  if (entity.kind === 'artist') {
    const g = artistGaps(went, today);
    if (g.sinceLast !== undefined) lines.push(<>Last seen {g.sinceLast === 0 ? 'today' : `${spanLabel(g.sinceLast)} ago`} ({dayLabel(g.lastDate!)}).</>);
    if (g.longest) lines.push(<>Longest wait between shows: {spanLabel(g.longest.days)} ({dayLabel(g.longest.from)} to {dayLabel(g.longest.to)}).</>);
    if (g.dated && g.dated < g.total) lines.push(<span className="text-text-muted">Based on the {g.dated} of {g.total} events dated to the day.</span>);
    const by = data.links.filter((l) => l.toId === entity.id && l.role === 'introduced_me_to').map((l) => byId.get(l.fromId)).filter((p): p is Entity => Boolean(p));
    if (by.length)
      lines.push(
        <span className="flex flex-wrap items-center gap-1.5">
          Introduced by
          {by.map((p) => (
            <button key={p.id} onClick={() => onOpen(p.id)} className={`${chipClass} hover:text-accent`}>
              {p.name}
            </button>
          ))}
        </span>,
      );
  }

  if (entity.kind === 'series') {
    const s = seriesStreak(went, entity.id);
    if (s.years.length) lines.push(<>Editions you went to: {s.years.join(', ')}.</>);
    if (s.longest && s.longest.length > 1) lines.push(<>Longest streak: {s.longest.length} years in a row ({s.longest.from} to {s.longest.to}).</>);
    if (s.latest && s.longest && s.latest !== s.longest && s.latest.length > 1) lines.push(<>Latest run: {s.latest.length} years ({s.latest.from} to {s.latest.to}).</>);
  }

  let introduced: Entity[] = [];
  if (entity.kind === 'person') {
    const p = personInsights(wentTo(allEvents, today), entity.id);
    if (p.together) lines.push(<>{p.together} show{p.together === 1 ? '' : 's'} together.</>);
    const sharedGenres = personGenreGroups(wentTo(allEvents, today), entity.id, byArtist);
    if (sharedGenres.length > 0) {
      lines.push(<>Your genres together: {sharedGenres.map((g) => g.toLowerCase()).join(', ')}</>);
    }
    if (p.first)
      lines.push(
        <>
          First show together:{' '}
          <button onClick={() => onOpenEvent(p.first!.id)} className="text-text hover:text-accent">
            <EventTitle event={p.first} />
          </button>{' '}
          <span className="font-mono tabular-nums text-text-muted">{whenLabel(p.first)}</span>
        </>,
      );
    if (p.onlyWith.length)
      lines.push(
        <span className="flex flex-wrap items-center gap-1.5">
          Seen only with them:
          {p.onlyWith.slice(0, 12).map((a) => (
            <span key={a.key} className={chipClass}>
              {a.name}
              {a.times > 1 && <span className="font-mono tabular-nums text-text-muted">×{a.times}</span>}
            </span>
          ))}
          {p.onlyWith.length > 12 && <span className="font-mono text-xs tabular-nums text-text-muted">+{p.onlyWith.length - 12}</span>}
        </span>,
      );
    introduced = data.links
      .filter((l) => l.fromId === entity.id && l.role === 'introduced_me_to')
      .map((l) => byId.get(l.toId))
      .filter((a): a is Entity => Boolean(a));
  }

  const artists = data.entities.filter((e) => e.kind === 'artist' && !e.mergedIntoId && !introduced.includes(e));
  if (!lines.length && entity.kind !== 'person') return null;
  return (
    <div className="space-y-1.5">
      <h3 className={sectionTitle}>Insights</h3>
      {lines.length ? (
        <ul className="space-y-1 text-sm text-text-muted">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-muted">Nothing yet: insights come from the events you went to.</p>
      )}
      {entity.kind === 'person' && (
        <div className="space-y-1.5 pt-1">
          <p className="text-xs text-text-muted">Introduced you to</p>
          {introduced.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {introduced.map((a) => (
                <li key={a.id} className={chipClass}>
                  <button onClick={() => onOpen(a.id)} className="hover:text-accent">
                    {a.name}
                  </button>
                  <button
                    onClick={() => void link(a, 'introduced_me_to', false)}
                    disabled={Boolean(busy)}
                    className="text-text-muted hover:text-bad"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Picker options={artists} placeholder="An artist they got you into…" label="Add an artist they introduced" onPick={(a) => void link(a, 'introduced_me_to', true)} />
        </div>
      )}
    </div>
  );
};
