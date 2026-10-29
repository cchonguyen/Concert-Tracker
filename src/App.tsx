import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, FolderCog, GalleryHorizontalEnd, Map as MapIcon, Mic2, Radio, Table2, Ticket, Users } from 'lucide-react';
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
import { ThemePicker } from './components/ThemePicker';
import { ManageTarget, ManageView } from './components/ManageView';
import { MeProvider, type Me } from './components/MeContext';
import { MembersPanel } from './components/MembersPanel';
import { PeopleProvider } from './components/PersonName';
import { wentTo } from './server/events/attendance';

type Tab = 'events' | 'table' | 'timeline' | 'map' | 'stats' | 'artists' | 'manage';

// The Table, Timeline and Map views keep their filters in the address (?view=table&...).
const FILTERED: Tab[] = ['table', 'timeline', 'map'];
const initialTab = (): Tab => {
  const view = new URLSearchParams(window.location.search).get('view') as Tab;
  return FILTERED.includes(view) ? view : 'events';
};

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
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
  const openTab = (next: Tab) => {
    const params = new URLSearchParams(window.location.search);
    if (FILTERED.includes(next) && FILTERED.includes(tab)) {
      params.set('view', next);
      if (next !== 'timeline') {
        params.delete('mode');
        params.delete('month');
      }
      window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
    } else if (FILTERED.includes(next)) window.history.replaceState(null, '', `${window.location.pathname}?view=${next}`);
    else if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
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

  return (
    <MeProvider me={me}>
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 selection:bg-violet-600 selection:text-white flex flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md">
        <div className={`mx-auto flex ${tab === 'table' ? 'max-w-7xl' : tab === 'map' ? 'max-w-6xl' : 'max-w-3xl'} items-center justify-between gap-3 px-4 py-3`}>
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
              {(
                [
                  ['events', Ticket, `Events`, events.length],
                  ['table', Table2, `Table`, null],
                  ['timeline', GalleryHorizontalEnd, `Timeline`, null],
                  ['map', MapIcon, `Map`, null],
                  ['stats', BarChart3, `Stats`, null],
                  ['artists', Mic2, `Artists`, seenCount],
                  ['manage', FolderCog, `Manage`, null],
                ] as const
              )
                .filter(([id]) => id !== 'manage' || me.role === 'owner')
                .map(([id, Icon, label, count]) => (
                <button
                  key={id}
                  onClick={() => openTab(id)}
                  title={label}
                  className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium transition-colors sm:px-3 ${
                    tab === id ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className={tab === id ? '' : 'hidden sm:inline'}>{label}</span>
                  {count !== null && <span className={`text-[11px] opacity-70 ${tab === id ? '' : 'hidden sm:inline'}`}>{count}</span>}
                </button>
              ))}
            </nav>
            {me.multiUser && me.role === 'owner' && (
              <button onClick={() => setMembers(true)} title="Members" aria-label="Members" className="rounded-lg border border-zinc-800 p-2 text-zinc-400 hover:text-zinc-200">
                <Users className="h-4 w-4" />
              </button>
            )}
            <ThemePicker />
          </div>
        </div>
      </header>

      {members && <MembersPanel onClose={() => setMembers(false)} />}

      <PeopleProvider events={events} version={events}>
      <main className={`mx-auto w-full ${tab === 'table' ? 'max-w-7xl' : tab === 'map' ? 'max-w-6xl' : 'max-w-3xl'} flex-1 space-y-6 px-4 py-6`}>
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
        {tab === 'events' && (
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
        {tab === 'table' && (
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
        {tab === 'timeline' && <TimelineTab events={events} lineups={lineups} editions={editions} onOpen={setSelectedId} onOpenTable={openTable} />}
        {tab === 'map' && <MapView events={went} lineups={lineups} editions={editions} onOpen={setSelectedId} onOpenTable={openTable} />}
        {tab === 'stats' && <StatsView events={events} onOpen={setSelectedId} onOpenTable={openTable} />}
        {tab === 'artists' && (
          <ArtistsView events={went} onOpenEvent={setSelectedId} onOpenTable={openTable} onManage={(key) => openManage({ kind: 'artist', name: key })} />
        )}
        {tab === 'manage' && (
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
    </MeProvider>
  );
}
