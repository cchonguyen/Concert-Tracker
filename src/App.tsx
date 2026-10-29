import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Compass, FolderCog, GalleryHorizontalEnd, House, Library, Map as MapIcon, Mic2, Radio, Table2, Ticket } from 'lucide-react';
import {
  EmailImport,
  eventsApi,
  importsApi,
  isActive,
  LineupFacts,
  LineupStatus,
  LineupSummary,
  lineupApi,
  LoggedEvent,
  SOURCE_LABELS,
  meApi,
} from './services/lineupApi';
import { CaptureBar } from './components/CaptureBar';
import { EventsHome } from './components/EventsHome';
import { EventDetail } from './components/EventDetail';
import { ArtistsView } from './components/ArtistsView';
import { ImportReview } from './components/ImportReview';
import { TableView } from './components/TableView';
import { StatsView } from './components/StatsView';
import { MapView } from './components/MapView';
import { TimelineTab } from './components/timeline/TimelineTab';
import { useTheme } from './components/ThemePicker';
import { MenuButton } from './components/MenuButton';
import { ManageTarget, ManageView } from './components/ManageView';
import { MeProvider, type Me } from './components/MeContext';
import { NoticeModal } from './components/NoticeModal';
import { MembersPanel } from './components/MembersPanel';
import { AccountPanel } from './components/AccountPanel';
import { VaultProvider } from './components/VaultContext';
import { PeopleProvider } from './components/PersonName';
import { wentTo } from './server/events/attendance';
import { NavStorage, Page, PAGE_LABELS, pageFromView, rememberedPage, rememberPage, sectionOf, SECTIONS, Section, subPagesFor, viewFor } from './services/nav';

// The Table, Timeline and Map views keep their filters in the address (?view=table&...).
const FILTERED: Page[] = ['table', 'timeline', 'map'];
const PAGE_ICON: Record<Page, typeof Ticket> = {
  home: House,
  summary: Ticket,
  table: Table2,
  manage: FolderCog,
  timeline: GalleryHorizontalEnd,
  map: MapIcon,
  stats: BarChart3,
  artists: Mic2,
};
const SECTION_ICON: Record<Section, typeof Ticket> = { library: Library, explore: Compass };

// Remembered subtabs live on this device; a browser that blocks storage just forgets them.
const navStorage = (): NavStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const initialPage = (): Page => pageFromView(new URLSearchParams(window.location.search).get('view'), { canManage: true });

export default function App() {
  const [tab, setTab] = useState<Page>(initialPage);
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [lineups, setLineups] = useState<Record<string, LineupSummary>>({});
  const [editions, setEditions] = useState<Record<string, LineupFacts>>({});
  const [researching, setResearching] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<LineupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [imports, setImports] = useState<EmailImport[]>([]);
  // Back from Connect Gmail (?gmail=connected, or what went wrong): open the review list.
  const [gmailNotice] = useState(() => new URLSearchParams(window.location.search).get('gmail'));
  const [reviewing, setReviewing] = useState(Boolean(gmailNotice));
  const [emailCheck, setEmailCheck] = useState(false);
  const [justAdded, setJustAdded] = useState<string[]>([]);
  // What another tab asked Manage to open.
  const [manageTarget, setManageTarget] = useState<ManageTarget | null>(null);
  // Single-owner installs answer owner; until /api/me answers, assume owner so nothing flickers away.
  const [me, setMe] = useState<Me>({ multiUser: false, role: 'owner', email: null });
  const [members, setMembers] = useState(false);
  const [account, setAccount] = useState(false);
  const theme = useTheme();
  useEffect(() => {
    meApi.get().then(setMe, () => undefined);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await eventsApi.list();
      setEvents(data.events);
      setLineups(data.lineups);
      setEditions(data.editions ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    lineupApi.status().then(setStatus).catch(() => undefined);
    // Nothing to show when email import was never run (or its table is missing).
    importsApi.list().then(setImports).catch(() => undefined);
    importsApi
      .scanStatus()
      .then((s) => setEmailCheck(s.configured))
      .catch(() => undefined);
    if (new URLSearchParams(window.location.search).has('gmail')) window.history.replaceState(null, '', window.location.pathname);
  }, [refresh]);

  // Poll while a lineup lookup is running somewhere.
  useEffect(() => {
    if (!Object.values(lineups).some((l) => isActive(l.status))) return;
    const t = setTimeout(() => void refresh(), 3000);
    return () => clearTimeout(t);
  }, [lineups, refresh]);

  const upsert = (event: LoggedEvent) =>
    setEvents((list) => (list.some((e) => e.id === event.id) ? list.map((e) => (e.id === event.id ? event : e)) : [event, ...list]));

  // Stage 1: the event is saved; details research follows on its own.
  const handleCaptured = async (event: LoggedEvent) => {
    upsert(event);
    setJustAdded((ids) => [event.id, ...ids.filter((id) => id !== event.id)]);
    setResearching((s) => new Set(s).add(event.id));
    try {
      upsert(await eventsApi.research(event.id));
    } catch {
      // The event is saved as typed; research can be re-run from the event.
    } finally {
      setResearching((s) => {
        const next = new Set(s);
        next.delete(event.id);
        return next;
      });
    }
    void refresh();
  };

  // Moving between the Table, Timeline and Map keeps the same filters.
  const openTab = (next: Page) => {
    const params = new URLSearchParams(window.location.search);
    if (next === 'home') {
      if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    } else {
      rememberPage(next, navStorage());
      if (FILTERED.includes(next) && FILTERED.includes(tab)) {
        params.set('view', next);
        if (next !== 'timeline') {
          params.delete('mode');
          params.delete('month');
        }
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
      } else window.history.replaceState(null, '', `${window.location.pathname}?${viewFor(next)}`);
    }
    setTab(next);
  };

  // Open the Table with these filters (a query string, as the Table writes it).
  const openTable = (query: string) => {
    window.history.replaceState(null, '', `${window.location.pathname}?view=table${query ? `&${query}` : ''}`);
    setTab('table');
  };

  // Open a record in Manage (from the Artists tab, the Table or an event).
  const openManage = (target: ManageTarget) => {
    setSelectedId(null);
    setManageTarget({ ...target });
    openTab('manage');
  };

  const today = new Date().toISOString().slice(0, 10);
  // Artists and the Map count only events you went to; upcoming ones and
  // ones you haven't confirmed wait in the Table and on the Events home.
  const went = useMemo(() => wentTo(events, today), [events, today]);
  const seenCount = new Set(went.flatMap((e) => e.seen.map((s) => s.key))).size;
  const selected = events.find((e) => e.id === selectedId) ?? null;
  const toReview = imports.filter((r) => r.status === 'new' && !r.eventId && !(r.startDate && r.startDate > today)).length;
  const canManage = me.role === 'owner';
  // Home has no page of its own until the Home page lands, so it shows Summary.
  // A member who cannot see Manage gets Summary there too.
  const shown: Page = tab === 'home' || (tab === 'manage' && !canManage) ? 'summary' : tab;
  const section = sectionOf(tab);
  const width = shown === 'table' ? 'max-w-7xl' : shown === 'map' ? 'max-w-6xl' : 'max-w-3xl';
  const counts: Partial<Record<Page, number>> = { summary: events.length, artists: seenCount };

  return (
    <MeProvider me={me}>
    {me.multiUser && me.noticeAccepted === false && (
      <NoticeModal onAccepted={() => setMe((m) => ({ ...m, noticeAccepted: true }))} />
    )}
    <VaultProvider events={events} onChanged={refresh}>
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 selection:bg-violet-600 selection:text-white flex flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md">
        <div className={`mx-auto flex ${width} items-center justify-between gap-3 px-4 py-3`}>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-violet-600 to-cyan-400">
              <Radio className="h-4 w-4 text-white" />
            </div>
            <span className="hidden text-base font-extrabold tracking-tight sm:inline">
              Live<span className="text-violet-400">Archive</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <nav className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1 text-sm">
              {(['home', 'library', 'explore'] as const).map((id) => {
                const Icon = id === 'home' ? House : SECTION_ICON[id];
                const label = id === 'home' ? PAGE_LABELS.home : SECTIONS[id].label;
                const active = id === 'home' ? tab === 'home' : section === id;
                return (
                  <button
                    key={id}
                    onClick={() => openTab(id === 'home' ? 'home' : rememberedPage(id, { canManage }, navStorage()))}
                    title={label}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium transition-colors sm:px-3 ${
                      active ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className={active ? '' : 'hidden sm:inline'}>{label}</span>
                  </button>
                );
              })}
            </nav>
            <MenuButton
              theme={theme}
              canMembers={me.multiUser && me.role === 'owner'}
              canAccount={me.multiUser}
              onMembers={() => setMembers(true)}
              onAccount={() => setAccount(true)}
            />
          </div>
        </div>
        {section && (
          <div className="border-t border-zinc-900">
            <div className={`mx-auto flex ${width} gap-1 overflow-x-auto px-4`}>
              {subPagesFor(section, { canManage }).map((p) => {
                const Icon = PAGE_ICON[p];
                const active = shown === p;
                const count = p === 'summary' ? events.length : p === 'artists' ? seenCount : null;
                return (
                  <button
                    key={p}
                    onClick={() => openTab(p)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                      active ? 'border-violet-500 text-violet-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {PAGE_LABELS[p]}
                    {count !== null && <span className="text-[11px] opacity-70">{count}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </header>

      {members && <MembersPanel onClose={() => setMembers(false)} />}
      {account && <AccountPanel onClose={() => setAccount(false)} />}

      <PeopleProvider events={events} version={events}>
      <main className={`mx-auto w-full ${width} flex-1 space-y-6 px-4 py-6`}>
        {section && <p className="text-xs text-zinc-500 sm:hidden">{`${SECTIONS[section].label} › ${PAGE_LABELS[shown]}`}</p>}
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
        {shown === 'summary' && (
          <>
            <CaptureBar onCaptured={handleCaptured} />
            <EventsHome
              events={events}
              lineups={lineups}
              researching={researching}
              justAdded={justAdded}
              toReview={toReview}
              emailCheck={emailCheck}
              loaded={loaded}
              onOpen={setSelectedId}
              onReviewEmail={() => setReviewing(true)}
              onOpenTable={openTable}
            />
          </>
        )}
        {shown === 'table' && (
          <TableView
            events={events}
            lineups={lineups}
            editions={editions}
            imports={imports}
            onOpen={setSelectedId}
            onChanged={upsert}
            onCaptured={handleCaptured}
            onManage={openManage}
            onImported={() => {
              void refresh();
              importsApi.list().then(setImports).catch(() => undefined);
            }}
          />
        )}
        {shown === 'timeline' && <TimelineTab events={events} lineups={lineups} editions={editions} onOpen={setSelectedId} onOpenTable={openTable} />}
        {shown === 'map' && <MapView events={went} lineups={lineups} editions={editions} onOpen={setSelectedId} onOpenTable={openTable} />}
        {shown === 'stats' && <StatsView events={events} onOpen={setSelectedId} onOpenTable={openTable} />}
        {shown === 'artists' && (
          <ArtistsView events={went} onOpenEvent={setSelectedId} onOpenTable={openTable} onManage={(key) => openManage({ kind: 'artist', name: key })} />
        )}
        {shown === 'manage' && (
          <ManageView
            events={events}
            target={manageTarget}
            onOpenEvent={setSelectedId}
            onOpenTable={openTable}
            onEventsChanged={() => void refresh()}
            onEventChanged={upsert}
          />
        )}
      </main>
      </PeopleProvider>

      <footer className="border-t border-zinc-900 py-5 text-xs text-zinc-500">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-end gap-3 px-4">
          {status && (
            <span title="Where event details and lineups come from">
              Sources:{' '}
              {status.sources.map((s) => `${SOURCE_LABELS[s.id]}${s.enabled ? '' : ' (off)'}`).join(' · ')}
              {' · '}Gemini {status.gemini ? `${status.quota?.used ?? 0}/${status.quota?.limit ?? '?'} today` : '(off)'}
            </span>
          )}
        </div>
      </footer>

      {reviewing && (
        <ImportReview
          imports={imports}
          events={events}
          onEventChanged={upsert}
          onChange={setImports}
          onAdded={(added) => {
            added.forEach(upsert);
            void refresh();
          }}
          onClose={() => setReviewing(false)}
          notice={gmailNotice}
        />
      )}

      {selected && (
        <EventDetail
          key={selected.id}
          event={selected}
          events={events}
          onChange={(e) => {
            upsert(e);
            void refresh();
          }}
          onDeleted={() => {
            setSelectedId(null);
            void refresh();
          }}
          onClose={() => setSelectedId(null)}
          onManage={openManage}
        />
      )}
    </div>
    </VaultProvider>
    </MeProvider>
  );
}
