import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, HeartPulse, History, Layers, Loader2, MapPin, Mic2, Plus, Search, Tag, Undo2, Users } from 'lucide-react';
import { entitiesApi, LoggedEvent } from '../services/lineupApi';
import type { Entity, EntityAlias, EntityKind, EntityLink, HistoryEntry } from '../server/entities/types';
import { norm } from '../services/listImport';
import { DataHealth } from './DataHealth';
import { ManageEntry } from './ManageEntry';
import { SeriesPanel } from './SeriesPanel';
import { MenuButton, type MenuOption } from './ui/MenuButton';

// The Manage tab: the records behind your events' names (artists, people,
// venues, places, series, organizations, labels), one list per kind. Open one to
// rename it everywhere, merge it into another, give it AKAs or links, and
// undo any change from History. See ARCHITECTURE.md ("Records").

export type ManageKind = EntityKind;

// What to open: a kind, and a name (or ID) to find in it.
export interface ManageTarget {
  kind: ManageKind;
  name?: string;
  id?: string;
}

export interface ManageData {
  entities: Entity[];
  aliases: EntityAlias[];
  links: EntityLink[];
  duplicates: string[][];
}

interface ManageViewProps {
  events: LoggedEvent[];
  target: ManageTarget | null;
  onOpenEvent: (id: string) => void;
  onOpenTable: (query: string) => void;
  onEventsChanged: () => void; // a rename or merge rewrote event names
  onEventChanged: (event: LoggedEvent) => void; // one event saved (Series)
}

export const KINDS: Array<{ kind: ManageKind; label: string; one: string; icon: React.ComponentType<{ className?: string }> }> = [
  { kind: 'artist', label: 'Artists', one: 'artist', icon: Mic2 },
  { kind: 'person', label: 'People', one: 'person', icon: Users },
  { kind: 'venue', label: 'Venues', one: 'venue', icon: Building2 },
  { kind: 'place', label: 'Places', one: 'place', icon: MapPin },
  { kind: 'series', label: 'Series', one: 'series', icon: Layers },
  { kind: 'organization', label: 'Organizations', one: 'organization', icon: Building2 },
  { kind: 'label', label: 'Labels', one: 'label', icon: Tag },
];

// Every section, in the Manage menu: the record kinds, then Data health and History.
const SECTION_OPTIONS: MenuOption<ManageKind | 'history' | 'health'>[] = [
  ...KINDS.map(({ kind, label, icon }) => ({ value: kind, label, icon })),
  { value: 'health' as const, label: 'Data health', icon: HeartPulse },
  { value: 'history' as const, label: 'History', icon: History },
];

// "Los Angeles, CA, United States" for a place; the name for the rest.
export const entityLabel = (e: Entity): string =>
  e.kind === 'place' ? [e.attrs.city ?? e.name, e.attrs.region, e.attrs.country].filter(Boolean).join(', ') : e.name;

// The events that point at each record, from the IDs saved on them.
export function eventsByEntity(events: LoggedEvent[]): Map<string, LoggedEvent[]> {
  const out = new Map<string, LoggedEvent[]>();
  const add = (id: string | null | undefined, e: LoggedEvent) => {
    if (!id) return;
    const list = out.get(id) ?? [];
    if (!list.includes(e)) list.push(e);
    out.set(id, list);
  };
  for (const e of events) {
    add(e.refs?.venueId, e);
    add(e.refs?.placeId, e);
    add(e.refs?.seriesId, e);
    e.refs?.companionIds.forEach((id) => add(id, e));
    e.seen.forEach((s) => add(s.artistId, e));
  }
  return out;
}

const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const ManageView: React.FC<ManageViewProps> = ({ events, target, onOpenEvent, onOpenTable, onEventsChanged, onEventChanged }) => {
  const [data, setData] = useState<ManageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ManageKind | 'history' | 'health'>(target?.kind ?? 'artist');
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newOrg, setNewOrg] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newGroup, setNewGroup] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await entitiesApi.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const loadHistory = useCallback(() => entitiesApi.history().then(setHistory).catch(() => undefined), []);
  useEffect(() => {
    void load();
    void loadHistory();
  }, [load, loadHistory]);

  const byId = useMemo(() => new Map((data?.entities ?? []).map((e) => [e.id, e])), [data]);

  // Open what another tab asked for, once the records are here.
  useEffect(() => {
    if (!target || !data) return;
    setKind(target.kind);
    setQuery('');
    let id = target.id && byId.has(target.id) ? target.id : null;
    if (!id && target.name) {
      const key = norm(target.name);
      const live = data.entities.filter((e) => e.kind === target.kind && !e.mergedIntoId);
      id =
        live.find((e) => e.nameNormalized === key || (e.kind === 'place' && norm(String(e.attrs.city ?? '')) === key))?.id ??
        data.aliases.find((a) => a.kind === target.kind && a.aliasNormalized === key)?.entityId ??
        null;
      const found = id ? byId.get(id) : undefined;
      if (found?.mergedIntoId) id = found.mergedIntoId;
    }
    setOpenId(id);
  }, [target, data, byId]);

  const counts = useMemo(() => eventsByEntity(events), [events]);
  const duplicateOf = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const g of data?.duplicates ?? []) for (const id of g) out.set(id, g.filter((x) => x !== id));
    return out;
  }, [data]);

  // After a change: fresh records, history and (when names moved) events.
  const changed = async (entry: HistoryEntry, eventsToo = entry.events.length > 0 || Boolean(entry.eventsChanged)) => {
    setNotice({ text: `${entry.summary}.`, undo: entry.operation === 'create' || !entry.id ? undefined : entry.id });
    await load();
    void loadHistory();
    if (eventsToo) onEventsChanged();
  };

  const undo = async (id: string) => {
    setBusy(`undo:${id}`);
    try {
      const r = await entitiesApi.undo(id);
      const skipped = r.skipped.length
        ? ` ${r.skipped.length} event${r.skipped.length === 1 ? '' : 's'} you changed since stayed as they are: ${r.skipped.map((s) => s.name).join(', ')}.`
        : '';
      setNotice({ text: `Undid: ${r.entry.summary}.${skipped}` });
      await load();
      void loadHistory();
      onEventsChanged();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const addOrganization = async () => {
    setBusy('org');
    try {
      const { entity, entry } = await entitiesApi.createOrganization(newOrg);
      setNewOrg('');
      await changed(entry, false);
      setOpenId(entity.id);
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const addLabel = async () => {
    setBusy('label');
    try {
      const { entity, entry } = await entitiesApi.createLabel(newLabel, newGroup.trim() || undefined);
      setNewLabel('');
      await changed(entry, false);
      setOpenId(entity.id);
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  // Series: the record's rename, for the Series panel's "Rename all".
  const renameSeries = async (from: string, to: string) => {
    const record = data?.entities.find((e) => e.kind === 'series' && !e.mergedIntoId && e.nameNormalized === norm(from));
    if (!record) throw new Error(`No series record for “${from}” yet. Reload and try again.`);
    await changed(await entitiesApi.rename(record.id, to), true);
  };

  if (error) {
    return <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>;
  }
  if (!data) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;

  const open = openId ? byId.get(openId) : undefined;
  const live = kind === 'history' || kind === 'health' ? [] : data.entities.filter((e) => e.kind === kind && !e.mergedIntoId);
  const q = norm(query);
  const matches = (e: Entity) =>
    !q || norm(entityLabel(e)).includes(q) || data.aliases.some((a) => a.entityId === e.id && a.aliasNormalized.includes(q));
  const list = live
    .filter(matches)
    .sort((a, b) => (counts.get(b.id)?.length ?? 0) - (counts.get(a.id)?.length ?? 0) || entityLabel(a).localeCompare(entityLabel(b)));
  const meta = KINDS.find((k) => k.kind === kind);
  // The search box belongs to a record list: not on Data health, History or an open record.
  const showSearch = kind !== 'history' && kind !== 'health' && !(open && open.kind === kind);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-zinc-50">Manage</h1>
        <p className="text-xs text-zinc-400">
          The names on your events, one record each. Rename one to change it on every event, merge two that are the same, and keep other
          spellings as AKAs. Every change can be undone from History.
        </p>
      </div>

      {/* One menu for the section, on the row with the search box (on the right). */}
      <div className="flex items-center gap-2">
        {showSearch && (
          <label className="relative block min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-zinc-400" />
            <input
              className={`${control} pl-8`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Find ${meta?.label.toLowerCase()} by name or AKA`}
              aria-label="Find"
            />
          </label>
        )}
        <MenuButton
          label="Manage section"
          value={kind}
          options={SECTION_OPTIONS}
          onChange={(k) => {
            setKind(k);
            setOpenId(null);
            setQuery('');
          }}
          className={showSearch ? '' : 'ml-auto'}
        />
      </div>

      {notice && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 text-sm text-zinc-200">
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.undo && (
            <button
              onClick={() => void undo(notice.undo!)}
              disabled={Boolean(busy)}
              className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200 disabled:opacity-40"
            >
              <Undo2 className="h-3.5 w-3.5" /> Undo
            </button>
          )}
          <button onClick={() => setNotice(null)} className="text-xs text-zinc-400 hover:text-zinc-300">
            Dismiss
          </button>
        </div>
      )}

      {kind === 'health' ? (
        <DataHealth
          data={data}
          events={events}
          counts={counts}
          onOpen={(id) => {
            const e = byId.get(id);
            if (e) setKind(e.kind);
            setOpenId(id);
          }}
          onChanged={changed}
        />
      ) : kind === 'history' ? (
        <section className="space-y-2">
          {!history ? (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
          ) : !history.length ? (
            <p className="text-sm text-zinc-400">No changes yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900">
              {history.map((h) => (
                <li key={h.id} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className={h.undoneAt ? 'text-zinc-400 line-through' : 'text-zinc-200'}>{h.summary}</span>
                    <span className="block text-[11px] text-zinc-400">
                      {when(h.createdAt)}
                      {h.undoneAt && ` · undone ${when(h.undoneAt)}`}
                    </span>
                  </span>
                  {!h.undoneAt && h.operation !== 'create' && (
                    <button
                      onClick={() => void undo(h.id)}
                      disabled={Boolean(busy)}
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-400 hover:text-violet-300 disabled:opacity-40"
                    >
                      {busy === `undo:${h.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} Undo
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-zinc-400">
            Undo puts names back on every event you haven't changed since. A change can only be undone after the later changes to the same
            records.
          </p>
        </section>
      ) : open && open.kind === kind ? (
        <ManageEntry
          key={open.id}
          entity={open}
          data={data}
          events={counts.get(open.id) ?? []}
          allEvents={events}
          duplicates={(duplicateOf.get(open.id) ?? []).map((id) => byId.get(id)!).filter(Boolean)}
          onBack={() => setOpenId(null)}
          onOpen={setOpenId}
          onOpenEvent={onOpenEvent}
          onOpenTable={onOpenTable}
          onChanged={changed}
        />
      ) : (
        <section className="space-y-3">
          {kind === 'series' && (
            <details className="rounded-xl border border-zinc-900 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-zinc-200">Link the years of a festival or tour</summary>
              <div className="pt-3">
                <SeriesPanel
                  embedded
                  events={events}
                  onChanged={onEventChanged}
                  onRename={renameSeries}
                  onOpen={onOpenEvent}
                  onShow={(series) => onOpenTable(`series=${encodeURIComponent(series)}`)}
                  onClose={() => undefined}
                />
              </div>
            </details>
          )}
          {kind === 'organization' && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newOrg.trim()) void addOrganization();
              }}
            >
              <input className={control} value={newOrg} onChange={(e) => setNewOrg(e.target.value)} placeholder="Insomniac, Goldenvoice…" aria-label="New organization" />
              <button
                type="submit"
                disabled={!newOrg.trim() || Boolean(busy)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
              >
                {busy === 'org' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
              </button>
            </form>
          )}
          {kind === 'label' && (
            <form
              className="flex flex-wrap gap-2 sm:flex-nowrap"
              onSubmit={(e) => {
                e.preventDefault();
                if (newLabel.trim()) void addLabel();
              }}
            >
              <input className={control} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Outdoor" aria-label="New label" />
              <input
                className={control}
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                placeholder="Group (optional): Indoor/Outdoor"
                aria-label="Label group"
                list="label-groups"
              />
              <datalist id="label-groups">
                {[...new Set(data.entities.filter((e) => e.kind === 'label' && typeof e.attrs.group === 'string').map((e) => String(e.attrs.group)))].map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
              <button
                type="submit"
                disabled={!newLabel.trim() || Boolean(busy)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
              >
                {busy === 'label' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
              </button>
            </form>
          )}
          {list.length ? (
            <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900">
              {list.map((e) => {
                const n = e.kind === 'label' ? data.links.filter((l) => l.toId === e.id && l.role === 'has_label').length : (counts.get(e.id)?.length ?? 0);
                const akas = data.aliases.filter((a) => a.entityId === e.id).length;
                const hosts = e.kind === 'series' ? data.links.filter((l) => l.fromId === e.id && l.role === 'hosted_by').length : 0;
                return (
                  <li key={e.id}>
                    <button onClick={() => setOpenId(e.id)} className="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-zinc-900/60">
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{entityLabel(e)}</span>
                      {duplicateOf.has(e.id) && (
                        <span className="shrink-0 rounded bg-amber-950/50 px-1.5 text-[11px] text-amber-300" title="Another record looks like the same one">
                          Look-alike
                        </span>
                      )}
                      {akas > 0 && <span className="shrink-0 text-[11px] text-zinc-400">{akas} AKA</span>}
                      {hosts > 0 && <span className="shrink-0 text-[11px] text-zinc-400">hosted</span>}
                      {e.kind === 'label' && typeof e.attrs.group === 'string' && <span className="shrink-0 text-[11px] text-zinc-400">{e.attrs.group}</span>}
                      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-zinc-400">{e.kind === 'organization' ? '' : n}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-zinc-400">
              {live.length
                ? 'Nothing matches.'
                : kind === 'organization'
                  ? 'No organizations yet. Add the promoters and record labels that put on your series.'
                  : kind === 'label'
                    ? 'No labels yet. Add one, such as Outdoor with the group Indoor/Outdoor, then put it on venues and series.'
                  : `No ${meta?.label.toLowerCase()} yet. They appear here from the names on your events.`}
            </p>
          )}
        </section>
      )}
    </div>
  );
};
