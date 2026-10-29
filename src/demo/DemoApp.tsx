import { useState } from 'react';
import type { LoggedEvent } from '../server/events/types';
import { EventsHome } from '../components/EventsHome';
import { TableView } from '../components/TableView';
import { TimelineTab } from '../components/timeline/TimelineTab';
import { MapView } from '../components/MapView';
import { StatsView } from '../components/StatsView';
import { ArtistsView } from '../components/ArtistsView';
import { Dialog } from '../components/ui/Dialog';
import { DemoEventDetail } from './DemoEventDetail';
import { DemoPrompt } from './DemoPrompt';
import { sampleEditions, sampleEvents, sampleLineups, samplePoints } from './sampleData';

// The demo shell: the app's own views over sample data. Write buttons open an
// explainer (DemoPrompt) instead of doing anything.

type Tab = 'summary' | 'table' | 'timeline' | 'map' | 'stats' | 'ranking';
const TABS: Array<[Tab, string]> = [
  ['summary', 'Summary'],
  ['table', 'Table'],
  ['timeline', 'Timeline'],
  ['map', 'Map'],
  ['stats', 'Stats'],
  ['ranking', 'Ranking'],
];
const TIMELINE_MODES = ['agenda', 'month', 'heatmap', 'river'] as const;

export function DemoApp() {
  const [tab, setTab] = useState<Tab>('summary');
  const [mode, setMode] = useState<(typeof TIMELINE_MODES)[number]>('agenda');
  const [openId, setOpenId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const events: LoggedEvent[] = sampleEvents;
  const went = events.filter((e) => !e.attendance);
  const opened = events.find((e) => e.id === openId) ?? null;
  const ask = (action: string) => () => setPrompt(action);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div role="note" className="flex flex-wrap items-center justify-between gap-2 bg-violet-600/20 px-4 py-2 text-sm">
        <span>Sample data. Nothing here is real.</span>
        <a href="/app" className="font-medium text-violet-200 underline">
          Log in (invite only)
        </a>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="font-semibold">
            LiveArchive
          </a>
          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">Demo</span>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <button type="button" onClick={ask('add')} className="rounded-lg border border-zinc-700 px-3 py-1.5">
            Add
          </button>
          <button type="button" onClick={ask('import')} className="rounded-lg border border-zinc-700 px-3 py-1.5">
            Import
          </button>
          <button type="button" onClick={ask('email')} className="rounded-lg border border-zinc-700 px-3 py-1.5">
            Check email
          </button>
          <button type="button" onClick={ask('share')} className="rounded-lg border border-zinc-700 px-3 py-1.5">
            Share
          </button>
        </div>
      </header>

      <nav aria-label="Demo sections" className="flex flex-wrap gap-1 px-4 pb-3">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => {
              setOpenId(null);
              setTab(id);
            }}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === id ? 'bg-violet-500 text-white' : 'text-zinc-300 hover:bg-zinc-800'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="space-y-4 px-4 pb-16">
        {opened ? (
          <DemoEventDetail event={opened} onClose={() => setOpenId(null)} />
        ) : tab === 'summary' ? (
          <EventsHome
            events={events}
            lineups={sampleLineups}
            researching={new Set()}
            justAdded={[]}
            toReview={0}
            emailCheck={false}
            loaded
            onOpen={setOpenId}
            onReviewEmail={ask('email')}
            onOpenTable={() => setTab('table')}
          />
        ) : tab === 'table' ? (
          <TableView
            events={events}
            lineups={sampleLineups}
            editions={sampleEditions}
            onOpen={setOpenId}
            onChanged={() => undefined}
            onManage={ask('manage')}
            onImport={ask('import')}
            onSheets={ask('sheets')}
            onRefresh={() => undefined}
          />
        ) : tab === 'timeline' ? (
          <div className="space-y-3">
            <div className="flex gap-1">
              {TIMELINE_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-lg px-3 py-1 text-sm capitalize ${mode === m ? 'bg-zinc-700' : 'text-zinc-400'}`}
                >
                  {m}
                </button>
              ))}
            </div>
            <TimelineTab
              mode={mode}
              events={events}
              lineups={sampleLineups}
              editions={sampleEditions}
              onOpen={setOpenId}
              onOpenTable={() => setTab('table')}
              onShowInAgenda={() => setMode('agenda')}
            />
          </div>
        ) : tab === 'map' ? (
          <MapView
            events={went}
            lineups={sampleLineups}
            editions={sampleEditions}
            onOpen={setOpenId}
            onOpenTable={() => setTab('table')}
            pointFor={(city) => samplePoints[city] ?? null}
          />
        ) : tab === 'stats' ? (
          <StatsView events={events} onOpen={setOpenId} onOpenTable={() => setTab('table')} />
        ) : (
          <ArtistsView events={went} onOpenEvent={setOpenId} onOpenTable={() => setTab('table')} onManage={ask('manage')} />
        )}
      </main>

      {prompt && (
        <Dialog title="Sample data" onClose={() => setPrompt(null)}>
          <DemoPrompt action={prompt} onBack={() => setPrompt(null)} />
        </Dialog>
      )}
    </div>
  );
}
