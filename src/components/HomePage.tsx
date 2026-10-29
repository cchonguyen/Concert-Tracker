import React from 'react';
import { PAGE_ICON } from './pageIcons';
import { Page, PAGE_LABELS, Section, SECTIONS, subPagesFor, SubPage } from '../services/nav';

interface HomePageProps {
  canManage: boolean;
  eventCount: number;
  cityCount: number;
  artistCount: number;
  onOpen: (page: Page) => void;
}

// What each page is for, in one friendly line.
const BLURB: Record<SubPage, string> = {
  summary: 'Every show, newest first.',
  table: 'Sort, filter and edit your shows in bulk.',
  manage: 'Rename and merge artists, venues and series.',
  timeline: 'Your shows laid out over time.',
  map: 'Every city you have been to.',
  stats: 'Numbers from all your years of going out.',
  artists: 'Everyone you have seen live.',
};

const TINT: Record<Section, string> = {
  library: 'border-violet-500/30 bg-violet-500/5',
  explore: 'border-zinc-700 bg-zinc-900',
};

// Doors into the app: one card per page, grouped by section. Tapping a card
// opens that page and remembers it for its section.
export const HomePage: React.FC<HomePageProps> = ({ canManage, eventCount, cityCount, artistCount, onOpen }) => {
  const empty = eventCount === 0;
  const live = (p: SubPage): { n: number; unit: string } | null => {
    if (p === 'summary') return { n: eventCount, unit: eventCount === 1 ? 'event' : 'events' };
    if (p === 'map') return { n: cityCount, unit: cityCount === 1 ? 'city' : 'cities' };
    if (p === 'artists') return { n: artistCount, unit: artistCount === 1 ? 'artist' : 'artists' };
    return null;
  };
  const sections = Object.keys(SECTIONS) as Section[];

  return (
    <div className="space-y-6">
      {empty && <p className="text-sm text-zinc-400">Start with one show you remember. Quick add is in the top bar.</p>}
      {sections.map((section) => (
          <section key={section} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{SECTIONS[section].label}</h2>
            <div className={`grid gap-3 sm:grid-cols-2 ${empty ? 'opacity-60' : ''}`}>
              {subPagesFor(section, { canManage }).map((p) => {
                const Icon = PAGE_ICON[p];
                const count = live(p);
                return (
                  <button
                    key={p}
                    onClick={() => onOpen(p)}
                    className={`group flex items-center gap-4 rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:border-violet-500/60 active:scale-[0.98] ${TINT[section]}`}
                  >
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-violet-600/20 text-violet-300">
                      <Icon className="h-7 w-7" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-bold text-zinc-100">{PAGE_LABELS[p]}</span>
                      <span className="block text-sm text-zinc-400">{BLURB[p]}</span>
                    </span>
                    {count && (
                      <span className="shrink-0 text-right">
                        <span className="block text-3xl font-extrabold tabular-nums text-zinc-100">{count.n}</span>
                        <span className="block text-xs text-zinc-500">{count.unit}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
      ))}
    </div>
  );
};
