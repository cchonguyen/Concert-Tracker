import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, Mic2, Radio, Table2, Ticket } from 'lucide-react';
import { EmailImport, eventsApi, importsApi, isActive, LineupStatus, LineupSummary, lineupApi, LoggedEvent, SOURCE_LABELS } from './services/lineupApi';
import { CaptureBar } from './components/CaptureBar';
import { EventsHome } from './components/EventsHome';
import { EventDetail } from './components/EventDetail';
import { ArtistsView } from './components/ArtistsView';
import { ImportReview } from './components/ImportReview';
import { TableView } from './components/TableView';
import { StatsView } from './components/StatsView';

type Tab = 'events' | 'table' | 'stats' | 'artists';

// The Table view keeps its filters in the address (?view=table&...).
const initialTab = (): Tab => (new URLSearchParams(window.location.search).get('view') === 'table' ? 'table' : 'events');

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [lineups, setLineups] = useState<Record<string, LineupSummary>>({});
  const [researching, setResearching] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<LineupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [imports, setImports] = useState<EmailImport[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [justAdded, setJustAdded] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const data = await eventsApi.list();
      setEvents(data.events);
      setLineups(data.lineups);
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

  const openTab = (next: Tab) => {
    if (next !== 'table' && window.location.search) window.history.replaceState(null, '', window.location.pathname);
    setTab(next);
  };

  // Open the Table with these filters (a query string, as the Table writes it).
  const openTable = (query: string) => {
    window.history.replaceState(null, '', `${window.location.pathname}?view=table${query ? `&${query}` : ''}`);
    setTab('table');
  };

  const seenCount = new Set(events.flatMap((e) => e.seen.map((s) => s.key))).size;
  const selected = events.find((e) => e.id === selectedId) ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const toReview = imports.filter((r) => r.status === 'new' && !r.eventId && !(r.startDate && r.startDate > today)).length;

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 selection:bg-violet-600 selection:text-white flex flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md">
        <div className={`mx-auto flex ${tab === 'table' ? 'max-w-6xl' : 'max-w-3xl'} items-center justify-between gap-3 px-4 py-3`}>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-violet-600 to-cyan-400">
              <Radio className="h-4 w-4 text-white" />
            </div>
            <span className="hidden text-base font-extrabold tracking-tight sm:inline">
              Live<span className="text-violet-400">Archive</span>
            </span>
          </div>
          <nav className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1 text-sm">
            {(
              [
                ['events', Ticket, `Events`, events.length],
                ['table', Table2, `Table`, null],
                ['stats', BarChart3, `Stats`, null],
                ['artists', Mic2, `Artists`, seenCount],
              ] as const
            ).map(([id, Icon, label, count]) => (
              <button
                key={id}
                onClick={() => openTab(id)}
                title={label}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors ${
                  tab === id ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className={tab === id ? '' : 'hidden sm:inline'}>{label}</span>
                {count !== null && <span className="text-[11px] opacity-70">{count}</span>}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className={`mx-auto w-full ${tab === 'table' ? 'max-w-6xl' : 'max-w-3xl'} flex-1 space-y-6 px-4 py-6`}>
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
            imports={imports}
            onOpen={setSelectedId}
            onImported={() => {
              void refresh();
              importsApi.list().then(setImports).catch(() => undefined);
            }}
          />
        )}
        {tab === 'stats' && <StatsView events={events} onOpen={setSelectedId} onOpenTable={openTable} />}
        {tab === 'artists' && <ArtistsView events={events} onOpenEvent={setSelectedId} />}
      </main>

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
          onChange={setImports}
          onAdded={(added) => {
            added.forEach(upsert);
            void refresh();
          }}
          onClose={() => setReviewing(false)}
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
        />
      )}
    </div>
  );
}
