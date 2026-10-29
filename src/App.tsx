import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHideOnScroll } from './components/headerScroll';
import { House, Radio } from 'lucide-react';
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
import { QuickAdd, QuickAddButton, QuickAddFab, SavedToast } from './components/QuickAdd';
import { DataPanel, exportCsv } from './components/DataActions';
import { ListImport } from './components/ListImport';
import { SheetSync } from './components/SheetSync';
import { ManageTarget, ManageView } from './components/ManageView';
import { MeProvider, type Me } from './components/MeContext';
import { NoticeModal } from './components/NoticeModal';
import { MembersPanel } from './components/MembersPanel';
import { AccountPanel } from './components/AccountPanel';
import { VaultProvider } from './components/VaultContext';
import { PeopleProvider } from './components/PersonName';
import { wentTo } from './server/events/attendance';
import { hintSeen, markHintSeen, NavStorage, Page, PAGE_BLURB, SubPage, PAGE_LABELS, pageFromView, rememberedPage, rememberPage, sectionOf, SECTIONS, subPagesFor, viewFor } from './services/nav';
import { PAGE_ICON, SECTION_ICON } from './components/pageIcons';
import { HomePage } from './components/HomePage';
import { BackToTop } from './components/ui/BackToTop';
import { cityOf } from './services/table';
import { homeSummary } from './services/home';

// The Table, the four timeline views and the Map keep their filters in the address (?view=table&...).
const FILTERED: Page[] = ['table', 'agenda', 'month', 'heatmap', 'river', 'map'];
const TIMELINE_PAGES: Page[] = ['agenda', 'month', 'heatmap', 'river'];
// Pages with a title line, and long pages that get Back to top (Agenda and Table have their own).
const HEADED: Page[] = ['stats', 'map', 'ranking'];
const BACK_TO_TOP: Page[] = ['summary', 'month', 'heatmap', 'stats', 'map', 'ranking', 'manage'];

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
  // An event the "to confirm" chip sent Agenda to, opened as Agenda mounts.
  const [agendaFocus, setAgendaFocus] = useState<string | null>(null);
  // The one-line icon-tabs hint shows on a phone's first visit to a section, then never again.
  const [hintDue, setHintDue] = useState(() => !hintSeen(navStorage()));
  // Single-owner installs answer owner; until /api/me answers, assume owner so nothing flickers away.
  const [me, setMe] = useState<Me>({ multiUser: false, role: 'owner', email: null });
  const [members, setMembers] = useState(false);
  const [account, setAccount] = useState(false);
  const theme = useTheme();
  const [quickAdd, setQuickAdd] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const headerShown = useHideOnScroll(headerRef);
  const [saved, setSaved] = useState<LoggedEvent | null>(null);
  const dismissSaved = useCallback(() => setSaved(null), []);
  const closeQuickAdd = useCallback(() => setQuickAdd(false), []);
  // Import and Google Sheets open from the Menu, the Table and Quick add alike.
  // Back from Google's sign-in (?sheets=...) opens Sheets straight away.
  const [sheetsNotice] = useState(() => new URLSearchParams(window.location.search).get('sheets'));
  const [dataPanel, setDataPanel] = useState<DataPanel | null>(() => (sheetsNotice ? 'sheets' : null));
  const openImport = () => setDataPanel('import');
  const openSheets = () => setDataPanel('sheets');
  const closeDataPanel = useCallback(() => setDataPanel(null), []);

  // N opens Quick add, unless you are typing or another panel is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'n' && e.key !== 'N') || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (reviewing || selectedId || members || account || quickAdd) return;
      e.preventDefault();
      setQuickAdd(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [reviewing, selectedId, members, account, quickAdd]);
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

  // Moving between the Table, the timeline views and the Map keeps the same filters.
  const openTab = (next: Page) => {
    setAgendaFocus(null);
    // Picking a page from a section's strip is the hint's cue, so it is done. Entering a section from Home is not.
    if (sectionOf(tab)) {
      setHintDue(false);
      markHintSeen(navStorage());
    }
    const params = new URLSearchParams(window.location.search);
    if (next === 'home') {
      if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    } else {
      rememberPage(next, navStorage());
      if (FILTERED.includes(next) && FILTERED.includes(tab)) {
        params.set('view', next);
        if (next !== 'month') params.delete('month');
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

  // Open a record in Manage (from the Ranking tab, the Table or an event).
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
  // A member who cannot see Manage gets Summary instead.
  const shown: Page = tab === 'manage' && !canManage ? 'summary' : tab;
  const section = sectionOf(tab);
  // The Table is wide; every other page shares one reading width.
  const width = shown === 'table' ? 'max-w-6xl' : 'max-w-3xl';
  // The top bar and sub-tabs use one width on every page, so they never jump when the page changes.
  const headerWidth = 'max-w-6xl';
  // The hint is for phones, where the subtabs are icons only.
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;
  useEffect(() => {
    if (!section || !hintDue || !phone) return;
    const t = setTimeout(() => {
      setHintDue(false);
      markHintSeen(navStorage());
    }, 6000);
    return () => clearTimeout(t);
  }, [section, hintDue, phone]);
  const cityCount = new Set(went.map((e) => cityOf(e)).filter(Boolean)).size;
  // Needs you on Home: shows waiting for a yes or no, and lineups still being looked up.
  const confirmCount = homeSummary(events, lineups, today).toConfirm.length;
  const researchingCount = Object.values(lineups).filter((l) => isActive(l.status)).length;

  return (
    <MeProvider me={me}>
    {me.multiUser && me.noticeAccepted === false && (
      <NoticeModal onAccepted={() => setMe((m) => ({ ...m, noticeAccepted: true }))} />
    )}
    <VaultProvider events={events} onChanged={refresh}>
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 selection:bg-violet-600 selection:text-white flex flex-col">
      <header
        ref={headerRef}
        className={`sticky top-0 z-30 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md transition-transform duration-200 motion-reduce:transition-none ${
          headerShown ? '' : '-translate-y-full'
        }`}
      >
        <div className={`mx-auto flex ${headerWidth} items-center justify-between gap-3 px-4 py-3`}>
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
            <QuickAddButton onClick={() => setQuickAdd(true)} />
            <MenuButton
              theme={theme}
              canMembers={me.multiUser && me.role === 'owner'}
              canAccount={me.multiUser}
              canSheets={me.role === 'owner'}
              onMembers={() => setMembers(true)}
              onAccount={() => setAccount(true)}
              onImport={openImport}
              onExport={() => exportCsv(events, editions)}
              onSheets={openSheets}
            />
          </div>
        </div>
        {section && (
          <div className="border-t border-zinc-900">
            <div className={`mx-auto flex ${headerWidth} gap-1 overflow-x-auto px-4`}>
              {subPagesFor(section, { canManage }).map((p) => {
                const Icon = PAGE_ICON[p];
                const active = shown === p;
                const count = p === 'summary' ? events.length : p === 'ranking' ? seenCount : null;
                return (
                  <button
                    key={p}
                    onClick={() => openTab(p)}
                    title={PAGE_LABELS[p]}
                    aria-label={PAGE_LABELS[p]}
                    aria-current={active ? 'page' : undefined}
                    className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                      active ? 'border-violet-500 text-violet-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {/* Phones show the icon alone, except on the open page. */}
                    <span className={active ? '' : 'hidden sm:inline'}>
                      {PAGE_LABELS[p]}
                      {count !== null && <span className="ml-1.5 text-[11px] opacity-70">{count}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            {hintDue && (
              <p className={`mx-auto ${headerWidth} px-4 pb-2 text-xs text-violet-300 sm:hidden`}>
                Tap an icon to switch pages.
              </p>
            )}
          </div>
        )}
      </header>

      {members && <MembersPanel onClose={() => setMembers(false)} />}
      {account && <AccountPanel onClose={() => setAccount(false)} />}

      <PeopleProvider events={events} version={events}>
      <main className={`mx-auto w-full ${width} flex-1 space-y-6 px-4 py-6`}>
        {section && <p className="text-xs text-zinc-500 sm:hidden">{`${SECTIONS[section].label} › ${PAGE_LABELS[shown]}`}</p>}
        {HEADED.includes(shown) && (
          <div>
            <h1 className="text-lg font-bold text-zinc-50">{PAGE_LABELS[shown]}</h1>
            <p className="text-xs text-zinc-500">{PAGE_BLURB[shown as SubPage]}</p>
          </div>
        )}
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
        {shown === 'home' && (
          <HomePage
            canManage={canManage}
            eventCount={events.length}
            cityCount={cityCount}
            artistCount={seenCount}
            needs={{ confirm: confirmCount, email: toReview, researching: researchingCount }}
            emailCheck={emailCheck}
            onCaptured={handleCaptured}
            onImport={openImport}
            onReviewEmail={() => setReviewing(true)}
            onOpenSummary={() => openTab('summary')}
            onOpen={openTab}
          />
        )}
        {shown === 'summary' && (
          <>
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
            onOpen={setSelectedId}
            onChanged={upsert}
            onCaptured={handleCaptured}
            onManage={openManage}
            onImport={openImport}
            onSheets={openSheets}
            onRefresh={() => void refresh()}
          />
        )}
        {TIMELINE_PAGES.includes(shown) && (
          <TimelineTab
            mode={shown as 'agenda' | 'month' | 'heatmap' | 'river'}
            focusEventId={agendaFocus}
            events={events}
            lineups={lineups}
            editions={editions}
            onOpen={setSelectedId}
            onOpenTable={openTable}
            onShowInAgenda={(id) => {
              openTab('agenda');
              setAgendaFocus(id);
            }}
          />
        )}
        {shown === 'map' && <MapView events={went} lineups={lineups} editions={editions} onOpen={setSelectedId} onOpenTable={openTable} />}
        {shown === 'stats' && <StatsView events={events} onOpen={setSelectedId} onOpenTable={openTable} />}
        {shown === 'ranking' && (
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

      {BACK_TO_TOP.includes(shown) && <BackToTop />}
      <QuickAddFab onClick={() => setQuickAdd(true)} />
      <QuickAdd
        open={quickAdd}
        onClose={closeQuickAdd}
        emailCheck={emailCheck}
        onImport={() => {
          setQuickAdd(false);
          openImport();
        }}
        onReviewEmail={() => setReviewing(true)}
        onCaptured={(event) => {
          setQuickAdd(false);
          setSaved(event);
          void handleCaptured(event);
        }}
      />
      {saved && <SavedToast event={saved} onOpen={setSelectedId} onDismiss={dismissSaved} />}

      {dataPanel === 'import' && (
        <ListImport
          events={events}
          imports={imports}
          onDone={() => {
            void refresh();
            importsApi.list().then(setImports).catch(() => undefined);
          }}
          onClose={closeDataPanel}
        />
      )}
      {dataPanel === 'sheets' && <SheetSync notice={sheetsNotice} onClose={closeDataPanel} />}

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
