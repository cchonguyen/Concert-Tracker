import React, { useCallback, useEffect, useState } from 'react';
import { Download, Mic2, Radio, Ticket } from 'lucide-react';
import { eventsApi, isActive, LineupStatus, LineupSummary, lineupApi, LoggedEvent, SOURCE_LABELS } from './services/lineupApi';
import { downloadText, eventsToCsv } from './services/format';
import { CaptureBar } from './components/CaptureBar';
import { EventList } from './components/EventList';
import { EventDetail } from './components/EventDetail';
import { ArtistsView } from './components/ArtistsView';

type Tab = 'events' | 'artists';

export default function App() {
  const [tab, setTab] = useState<Tab>('events');
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [lineups, setLineups] = useState<Record<string, LineupSummary>>({});
  const [researching, setResearching] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<LineupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  const seenCount = new Set(events.flatMap((e) => e.seen.map((s) => s.key))).size;
  const selected = events.find((e) => e.id === selectedId) ?? null;

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 selection:bg-violet-600 selection:text-white flex flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-violet-600 to-cyan-400">
              <Radio className="h-4 w-4 text-white" />
            </div>
            <span className="text-base font-extrabold tracking-tight">
              Live<span className="text-violet-400">Archive</span>
            </span>
          </div>
          <nav className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1 text-sm">
            {(
              [
                ['events', Ticket, `Events`, events.length],
                ['artists', Mic2, `Artists`, seenCount],
              ] as const
            ).map(([id, Icon, label, count]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors ${
                  tab === id ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                <span className="text-[11px] opacity-70">{count}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6">
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
        {tab === 'events' && (
          <>
            <CaptureBar onCaptured={handleCaptured} />
            <EventList events={events} lineups={lineups} researching={researching} loaded={loaded} onOpen={setSelectedId} />
          </>
        )}
        {tab === 'artists' && <ArtistsView events={events} onOpenEvent={setSelectedId} />}
      </main>

      <footer className="border-t border-zinc-900 py-5 text-xs text-zinc-500">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4">
          <button
            onClick={() => downloadText(`livearchive-${new Date().toISOString().slice(0, 10)}.csv`, eventsToCsv(events))}
            disabled={!events.length}
            className="inline-flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" /> Export as spreadsheet (CSV)
          </button>
          {status && (
            <span title="Where event details and lineups come from">
              Sources:{' '}
              {status.sources.map((s) => `${SOURCE_LABELS[s.id]}${s.enabled ? '' : ' (off)'}`).join(' · ')}
              {' · '}Gemini {status.gemini ? `${status.quota?.used ?? 0}/${status.quota?.limit ?? '?'} today` : '(off)'}
            </span>
          )}
        </div>
      </footer>

      {selected && (
        <EventDetail
          key={selected.id}
          event={selected}
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
