import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, HeartPulse, History, Layers, MapPin, Mic2, Plus, Search, Tag, Undo2, Users } from 'lucide-react';
import { canonicalApi, entitiesApi, LoggedEvent } from '../services/lineupApi';
import type { ArtistOrigin, CanonicalArtistSummary } from '../server/entities/canonicalManage';
import { normalizeName } from '../server/lineup/normalizeName';
import type { Entity, EntityAlias, EntityKind, EntityLink, HistoryEntry } from '../server/entities/types';
import { norm } from '../services/listImport';
import { DataHealth } from './DataHealth';
import { ManageEntry } from './ManageEntry';
import { SeriesPanel } from './SeriesPanel';
import { CollaborationsCard } from './CollaborationsCard';
import { Equalizer } from './ui/Equalizer';
import { HintPill } from './ui/HintPill';
import { Ledger } from './ui/Ledger';
import { MenuButton, type MenuOption } from './ui/MenuButton';
import { Pill } from './ui/Pill';
import { Segmented, type SegmentedOption } from './ui/Segmented';
import { Tabs } from './ui/Tabs';
import { CanonicalArchive, type ArchiveSection, type EditionStatus } from './CanonicalArchive';
import { useIsOwner } from './MeContext';
import { AdminInbox } from './AdminInbox';
import {
  parseManageParams,
  buildManageUrl,
  buildManageSearch,
  rememberManageSearch,
  entityUrl,
  isModifiedClick,
  type ManageRouteState,
} from '../services/manageNav';

const ORIGIN_BADGE: Record<ArtistOrigin, string> = {
  from_me: 'From me',
  unmanaged_fetch: 'Unmanaged fetch',
  community_import: 'Community import',
};

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

type Section = ManageKind | 'history' | 'health' | ArchiveSection;

// Every section, in the My records menu: the record kinds, then Data health and History.
const SECTION_OPTIONS: MenuOption<Section>[] = [
  ...KINDS.map(({ kind, label, icon }) => ({ value: kind, label, icon })),
  { value: 'health' as const, label: 'Data health', icon: HeartPulse },
  { value: 'history' as const, label: 'History', icon: History },
];

const VALID_KINDS: readonly string[] = [
  ...KINDS.map((k) => k.kind),
  'health',
  'history',
];

const isManageKind = (k?: string): k is ManageKind | 'history' | 'health' =>
  Boolean(k && VALID_KINDS.includes(k));

// The Global archive's sections, as header tabs (a row that scrolls sideways on narrow screens).
const ARCHIVE_TABS: Array<{ value: ArchiveSection; label: string }> = [
  { value: 'artists', label: 'Artists' },
  { value: 'series', label: 'Series' },
  { value: 'brands', label: 'Brands' },
  { value: 'editions', label: 'Editions & Lineups' },
  { value: 'lookups', label: 'Lookups' },
  { value: 'changes', label: 'Changes' },
];

const SCOPE_OPTIONS: SegmentedOption<'mine' | 'archive'>[] = [
  { value: 'mine', label: 'My records' },
  { value: 'archive', label: 'Global archive' },
];

const EDITION_STATUS_OPTIONS: MenuOption<EditionStatus>[] = [
  { value: 'all', label: 'All' },
  { value: 'verified', label: 'Verified' },
  { value: 'provisional', label: 'Provisional' },
  { value: 'draft', label: 'Drafts (owner only)' },
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
  'min-h-11 sm:min-h-9 w-full rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const ManageView: React.FC<ManageViewProps> = ({ events, target, onOpenEvent, onOpenTable, onEventsChanged, onEventChanged }) => {
  const [data, setData] = useState<ManageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const initial = useRef<ManageRouteState | null>(null);
  if (!initial.current) {
    initial.current = parseManageParams(typeof window !== 'undefined' ? window.location.search : '');
  }
  const init = initial.current;

  const [scope, setScope] = useState<'mine' | 'archive'>(init.scope);
  const [archiveSection, setArchiveSection] = useState<ArchiveSection>(init.section ?? 'editions');
  const [editionStatus, setEditionStatus] = useState<EditionStatus>(init.status ?? 'all');
  const [kind, setKind] = useState<ManageKind | 'history' | 'health'>(() => {
    if (init.kind && isManageKind(init.kind)) return init.kind;
    return target?.kind ?? 'artist';
  });
  const [openId, setOpenId] = useState<string | null>(init.id ?? target?.id ?? null);
  const [query, setQuery] = useState(init.q ?? '');

  const isOwner = useIsOwner();
  // Owner only: where each of my artist names also sits in the shared catalog (origin badges).
  // Lazy-loaded only when the Global Archive scope is opened, avoiding unnecessary egress on My records mount.
  const [origins, setOrigins] = useState<Map<string, CanonicalArtistSummary['origins']>>(new Map());
  const originsLoaded = useRef(false);
  useEffect(() => {
    if (!isOwner || scope !== 'archive' || originsLoaded.current) return;
    originsLoaded.current = true;
    canonicalApi
      .artists()
      .then(({ artists }) => setOrigins(new Map(artists.map((a) => [a.key, a.origins]))))
      .catch(() => {
        originsLoaded.current = false;
        setOrigins(new Map());
      });
  }, [isOwner, scope]);

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

  // Keep Manage state synchronized with browser Back and Forward navigation
  useEffect(() => {
    const onPop = () => {
      const parsed = parseManageParams(window.location.search);
      setScope(parsed.scope);
      if (parsed.scope === 'archive') {
        setArchiveSection(parsed.section ?? 'editions');
        setEditionStatus(parsed.status ?? 'all');
      } else {
        if (parsed.kind && isManageKind(parsed.kind)) {
          setKind(parsed.kind);
        }
      }
      setOpenId(parsed.id ?? null);
      setQuery(parsed.q ?? '');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openEntity = useCallback((id: string, targetKind?: ManageKind) => {
    const nextKind = targetKind ?? (byId.get(id)?.kind as ManageKind) ?? (kind !== 'history' && kind !== 'health' ? kind : 'artist');
    setKind(nextKind);
    setOpenId(id);
    const route: ManageRouteState = {
      scope: 'mine',
      kind: nextKind,
      id,
    };
    const url = buildManageUrl(route, window.location.pathname);
    window.history.pushState({ fromManageList: true, manageEntity: id }, '', url);
    rememberManageSearch(buildManageSearch(route));
  }, [byId, kind]);

  const closeEntity = useCallback(() => {
    if (window.history.state?.fromManageList) {
      window.history.back();
    } else {
      setOpenId(null);
      const entityKind = openId ? byId.get(openId)?.kind : undefined;
      const targetKind = entityKind ?? (kind !== 'history' && kind !== 'health' ? kind : 'artist');
      setKind(targetKind);
      const route: ManageRouteState = {
        scope: 'mine',
        kind: targetKind,
        q: query.trim() || undefined,
      };
      const url = buildManageUrl(route, window.location.pathname);
      window.history.replaceState(null, '', url);
      rememberManageSearch(buildManageSearch(route));
    }
  }, [byId, kind, openId, query]);

  // Open what another tab asked for, once the records are here.
  useEffect(() => {
    if (!target || !data) return;
    // A record lives in My records, so opening one leaves the archive scope.
    setScope('mine');
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
    if (id) {
      const route: ManageRouteState = {
        scope: 'mine',
        kind: target.kind,
        id,
      };
      const url = buildManageUrl(route, window.location.pathname);
      window.history.replaceState({ manageEntity: id }, '', url);
      rememberManageSearch(buildManageSearch(route));
    }
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
      openEntity(entity.id, 'organization');
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
      openEntity(entity.id, 'label');
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
    return <p className="rounded-card border border-bad/45 bg-bad/10 p-3 text-sm text-bad">{error}</p>;
  }
  if (!data) {
    return (
      <span role="status" aria-label="Loading manage data" className="inline-flex items-center text-text-muted">
        <Equalizer />
      </span>
    );
  }

  const open = openId ? byId.get(openId) : undefined;
  const live = kind === 'history' || kind === 'health' ? [] : data.entities.filter((e) => e.kind === kind && !e.mergedIntoId);
  const q = norm(query);
  const matches = (e: Entity) =>
    !q || norm(entityLabel(e)).includes(q) || data.aliases.some((a) => a.entityId === e.id && a.aliasNormalized.includes(q));
  const list = live
    .filter(matches)
    .sort((a, b) => (counts.get(b.id)?.length ?? 0) - (counts.get(a.id)?.length ?? 0) || entityLabel(a).localeCompare(entityLabel(b)));
  const meta = KINDS.find((k) => k.kind === kind);
  const archive = scope === 'archive' && isOwner;
  // The search box belongs to a record list: not on Data health, History or an open record.
  // In the archive it filters the artists or editions; Lookups has no list to search.
  // Only the artists and editions lists in the archive have anything to filter.
  const archiveFilters = archive && (archiveSection === 'artists' || archiveSection === 'series' || archiveSection === 'editions');
  const showSearch = archive ? archiveFilters : kind !== 'history' && kind !== 'health' && !(open && open.kind === kind);
  const searchPlaceholder = archive
    ? archiveSection === 'artists'
      ? 'Find artists in the archive by name or AKA'
      : archiveSection === 'series'
        ? 'Find series by name, brand or alias'
        : 'Search name, series or venue'
    : `Find ${meta?.label.toLowerCase()} by name or AKA`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-normal text-text">Manage</h1>
        <p className="text-xs text-text-muted">
          {archive
            ? 'The shared catalog: lineups you look up, the editions they make up, and the artists in them. Nothing here is added to your log.'
            : 'The names on your events, one record each. Rename one to change it on every event, merge two that are the same, and keep other spellings as AKAs. Every change can be undone from History.'}
        </p>
      </div>

      {/* The scope sits above the section menu; it changes what the menu, search and filters act on. */}
      {isOwner && (
        <Segmented
          label="Manage scope"
          options={SCOPE_OPTIONS}
          value={scope}
          onChange={(s) => {
            setScope(s);
            setOpenId(null);
            setQuery('');
            if (s === 'archive') {
              setArchiveSection('editions');
            }
            const route: ManageRouteState = s === 'archive'
              ? { scope: 'archive', section: 'editions', status: editionStatus !== 'all' ? editionStatus : undefined }
              : { scope: 'mine', kind };
            const url = buildManageUrl(route, window.location.pathname);
            window.history.replaceState(null, '', url);
            rememberManageSearch(buildManageSearch(route));
          }}
        />
      )}

      {/* The archive's sections are header tabs. */}
      {archive && (
        <Tabs
          label="Global archive sections"
          variant="underline"
          items={ARCHIVE_TABS}
          value={archiveSection}
          onChange={(v) => {
            setArchiveSection(v);
            setOpenId(null);
            setQuery('');
            const route: ManageRouteState = {
              scope: 'archive',
              section: v,
              status: v === 'editions' && editionStatus !== 'all' ? editionStatus : undefined,
            };
            const url = buildManageUrl(route, window.location.pathname);
            window.history.replaceState(null, '', url);
            rememberManageSearch(buildManageSearch(route));
          }}
        />
      )}

      {/* The search box, the edition filter and (in My records) the section menu share one row. */}
      {(!archive || archiveFilters) && (
        <div className="flex items-center gap-2">
          {showSearch && (
            <label className="relative block min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-text-muted sm:top-2.5" />
              <input
                className={`${control} pl-8`}
                value={query}
                onChange={(e) => {
                  const nextQ = e.target.value;
                  setQuery(nextQ);
                  const route: ManageRouteState = archive
                    ? {
                        scope: 'archive',
                        section: archiveSection,
                        status: archiveSection === 'editions' && editionStatus !== 'all' ? editionStatus : undefined,
                        q: nextQ.trim() || undefined,
                      }
                    : {
                        scope: 'mine',
                        kind,
                        q: nextQ.trim() || undefined,
                      };
                  const url = buildManageUrl(route, window.location.pathname);
                  window.history.replaceState(null, '', url);
                  rememberManageSearch(buildManageSearch(route));
                }}
                placeholder={searchPlaceholder}
                aria-label="Find"
              />
            </label>
          )}
          {archive && archiveSection === 'editions' && (
            <MenuButton
              label="Edition status"
              value={editionStatus}
              options={EDITION_STATUS_OPTIONS}
              onChange={(st) => {
                setEditionStatus(st);
                const route: ManageRouteState = {
                  scope: 'archive',
                  section: archiveSection,
                  status: st !== 'all' ? st : undefined,
                  q: query.trim() || undefined,
                };
                const url = buildManageUrl(route, window.location.pathname);
                window.history.replaceState(null, '', url);
                rememberManageSearch(buildManageSearch(route));
              }}
            />
          )}
          {!archive && (
            <MenuButton
              label="Manage section"
              value={kind}
              options={SECTION_OPTIONS}
              onChange={(s) => {
                const nextKind = s as ManageKind | 'history' | 'health';
                setKind(nextKind);
                setOpenId(null);
                setQuery('');
                const route: ManageRouteState = {
                  scope: 'mine',
                  kind: nextKind,
                };
                const url = buildManageUrl(route, window.location.pathname);
                window.history.replaceState(null, '', url);
                rememberManageSearch(buildManageSearch(route));
              }}
              className={showSearch ? '' : 'ml-auto'}
            />
          )}
        </div>
      )}

      {notice && (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface-1 p-2.5 text-sm text-text">
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.undo && (
            <button
              onClick={() => void undo(notice.undo!)}
              disabled={Boolean(busy)}
              className="inline-flex min-h-11 items-center gap-1 rounded-control px-1.5 text-accent hover:underline disabled:opacity-40 sm:min-h-9"
            >
              <Undo2 className="h-3.5 w-3.5" /> Undo
            </button>
          )}
          <button onClick={() => setNotice(null)} className="min-h-11 rounded-control px-1.5 text-xs text-text-muted hover:text-text sm:min-h-9">
            Dismiss
          </button>
        </div>
      )}

      {archive ? (
        <>
          {isOwner && <AdminInbox />}
          <CanonicalArchive section={archiveSection} query={query} status={editionStatus} />
        </>
      ) : kind === 'health' ? (
        <DataHealth
          data={data}
          events={events}
          counts={counts}
          onOpen={(id) => {
            const e = byId.get(id);
            openEntity(id, e?.kind);
          }}
          onChanged={changed}
        />
      ) : kind === 'history' ? (
        <section className="space-y-2">
          {!history ? (
            <span role="status" aria-label="Loading history" className="inline-flex items-center text-text-muted">
              <Equalizer />
            </span>
          ) : !history.length ? (
            <p className="text-sm text-text-muted">No changes yet.</p>
          ) : (
            <Ledger>
              {history.map((h) => (
                <Ledger.Row key={h.id} edge="none" className="min-h-11 justify-between px-3 py-2 text-sm sm:min-h-9">
                  <span className="min-w-0 flex-1">
                    <span className={h.undoneAt ? 'text-text-muted line-through' : 'text-text'}>{h.summary}</span>
                    <span className="block font-mono text-[11px] tabular-nums text-text-muted">
                      {when(h.createdAt)}
                      {h.undoneAt && ` · undone ${when(h.undoneAt)}`}
                    </span>
                  </span>
                  {!h.undoneAt && h.operation !== 'create' && (
                    <button
                      onClick={() => void undo(h.id)}
                      disabled={Boolean(busy)}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control px-1.5 text-xs text-text-muted hover:text-accent disabled:opacity-40 sm:min-h-9"
                    >
                      {busy === `undo:${h.id}` ? <Equalizer size="sm" /> : <Undo2 className="h-3 w-3" />} Undo
                    </button>
                  )}
                </Ledger.Row>
              ))}
            </Ledger>
          )}
          <p className="text-xs text-text-muted">
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
          onBack={closeEntity}
          onOpen={(id) => openEntity(id)}
          onOpenEvent={onOpenEvent}
          onOpenTable={onOpenTable}
          onChanged={changed}
        />
      ) : (
        <section className="space-y-3">
          {kind === 'artist' && (
            <CollaborationsCard
              allArtists={live.map((e) => ({ id: e.id, name: e.name }))}
              searchQuery={query}
              onOpenArtist={(id) => openEntity(id, 'artist')}
              onChanged={changed}
            />
          )}
          {kind === 'series' && (
            <details className="rounded-card border border-line bg-surface-1 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-text">Link the years of a festival or tour</summary>
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
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control bg-accent-fill px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40 sm:min-h-9"
              >
                {busy === 'org' ? <Equalizer size="sm" /> : <Plus className="h-3.5 w-3.5" />} Add
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
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control bg-accent-fill px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40 sm:min-h-9"
              >
                {busy === 'label' ? <Equalizer size="sm" /> : <Plus className="h-3.5 w-3.5" />} Add
              </button>
            </form>
          )}
          {list.length ? (
            <Ledger>
              {list.map((e) => {
                const n = e.kind === 'label' ? data.links.filter((l) => l.toId === e.id && l.role === 'has_label').length : (counts.get(e.id)?.length ?? 0);
                const akas = data.aliases.filter((a) => a.entityId === e.id).length;
                const hosts = e.kind === 'series' ? data.links.filter((l) => l.fromId === e.id && l.role === 'hosted_by').length : 0;
                const hasDup = duplicateOf.has(e.id);
                return (
                  <Ledger.Row key={e.id} edge={hasDup ? 'needs' : 'none'} className="hover:border-l-4 hover:bg-surface-2">
                    <a
                      href={entityUrl(kind, e.id)}
                      onClick={(ev) => {
                        if (isModifiedClick(ev)) return;
                        ev.preventDefault();
                        openEntity(e.id);
                      }}
                      className="flex w-full items-baseline gap-3 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{entityLabel(e)}</span>
                      {hasDup && (
                        <span title="Another record looks like the same one">
                          <HintPill tone="needs">Look-alike</HintPill>
                        </span>
                      )}
                      {e.kind === 'artist' &&
                        (origins.get(normalizeName(e.name)) ?? []).map((o) => (
                          <Pill key={o} tone="neutral">
                            {ORIGIN_BADGE[o]}
                          </Pill>
                        ))}
                      {akas > 0 && <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">{akas} AKA</span>}
                      {hosts > 0 && <span className="shrink-0 text-[11px] text-text-muted">hosted</span>}
                      {e.kind === 'label' && typeof e.attrs.group === 'string' && <span className="shrink-0 text-[11px] text-text-muted">{e.attrs.group}</span>}
                      <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">{e.kind === 'organization' ? '' : n}</span>
                    </a>
                  </Ledger.Row>
                );
              })}
            </Ledger>
          ) : (
            <p className="text-sm text-text-muted">
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
