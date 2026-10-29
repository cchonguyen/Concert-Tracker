import React from 'react';
import { Mail, Search, Ticket } from 'lucide-react';
import { CaptureBar } from './CaptureBar';
import { PAGE_ICON } from './pageIcons';
import { Page, PAGE_LABELS, Section, SECTIONS, subPagesFor, SubPage } from '../services/nav';
import { LoggedEvent } from '../services/lineupApi';

interface HomePageProps {
  canManage: boolean;
  eventCount: number;
  cityCount: number;
  artistCount: number;
  needs: { confirm: number; email: number; researching: number };
  emailCheck: boolean;
  onCaptured: (event: LoggedEvent) => void;
  onImport: () => void;
  onReviewEmail: () => void;
  onOpenSummary: () => void;
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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The landing page: the add box, what needs you, and one card per page.
export const HomePage: React.FC<HomePageProps> = ({
  canManage,
  eventCount,
  cityCount,
  artistCount,
  needs,
  emailCheck,
  onCaptured,
  onImport,
  onReviewEmail,
  onOpenSummary,
  onOpen,
}) => {
  const empty = eventCount === 0;
  const live = (p: SubPage): { n: number; unit: string } | null => {
    if (p === 'summary') return { n: eventCount, unit: eventCount === 1 ? 'event' : 'events' };
    if (p === 'map') return { n: cityCount, unit: cityCount === 1 ? 'city' : 'cities' };
    if (p === 'artists') return { n: artistCount, unit: artistCount === 1 ? 'artist' : 'artists' };
    return null;
  };
  const alerts = [
    needs.confirm > 0 && { key: 'confirm', text: plural(needs.confirm, 'show to confirm', 'shows to confirm'), icon: Ticket, onClick: onOpenSummary },
    needs.email > 0 && { key: 'email', text: plural(needs.email, 'ticket email to review', 'ticket emails to review'), icon: Mail, onClick: onReviewEmail },
    needs.researching > 0 && { key: 'research', text: `${needs.researching} lineup${needs.researching === 1 ? '' : 's'} researching`, icon: Search, onClick: onOpenSummary },
  ].filter((a): a is { key: string; text: string; icon: typeof Ticket; onClick: () => void } => Boolean(a));

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <CaptureBar
          onCaptured={onCaptured}
          label={empty ? 'Start with one show you remember' : undefined}
        />
        <div className="flex flex-wrap gap-4 text-sm">
          {emailCheck && (
            <button onClick={onReviewEmail} className="text-violet-300 hover:text-violet-200">
              Check ticket email
            </button>
          )}
          <button onClick={onImport} className="text-violet-300 hover:text-violet-200">
            Import a list
          </button>
        </div>
      </section>

      {alerts.length > 0 && (
        <section className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-300">Needs you</h2>
          <div className="flex flex-wrap gap-2">
            {alerts.map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.key}
                  onClick={a.onClick}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:border-amber-500/50"
                >
                  <Icon className="h-3.5 w-3.5" /> {a.text}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {(Object.keys(SECTIONS) as Section[]).map((section) => (
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
