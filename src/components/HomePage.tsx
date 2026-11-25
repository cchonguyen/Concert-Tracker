import React from 'react';
import { Mail, Search, Ticket } from 'lucide-react';
import { CaptureBar } from './CaptureBar';
import { PAGE_ICON } from './pageIcons';
import { Page, PAGE_BLURB, PAGE_LABELS, Section, SECTIONS, subPagesFor, SubPage } from '../services/nav';
import { LoggedEvent } from '../services/lineupApi';
import { EmailCard } from './EmailCard';
import { FeatureTiles } from './FeatureTiles';
import { YearTile } from './YearTile';
import type { YearReview } from '../services/stats';

interface HomePageProps {
  canManage: boolean;
  eventCount: number;
  cityCount: number;
  artistCount: number;
  yearReview: YearReview | null;
  yearCities: number;
  needs: { confirm: number; email: number; researching: number };
  emailCheck: boolean;
  onCaptured: (event: LoggedEvent) => void;
  onImport: () => void;
  onShare: () => void;
  onReviewEmail: () => void;
  onOpenSummary: () => void;
  onOpen: (page: Page) => void;
}

// What each page is for, in one friendly line.

const TINT: Record<Section, string> = {
  library: 'border-accent-tint-line bg-surface-1',
  explore: 'border-line-strong bg-surface-1',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The landing page: the add box, what needs you, and one card per page.
export const HomePage: React.FC<HomePageProps> = ({
  canManage,
  eventCount,
  cityCount,
  artistCount,
  yearReview,
  yearCities,
  needs,
  emailCheck,
  onCaptured,
  onImport,
  onShare,
  onReviewEmail,
  onOpenSummary,
  onOpen,
}) => {
  const empty = eventCount === 0;
  const live = (p: SubPage): { n: number; unit: string } | null => {
    if (p === 'summary') return { n: eventCount, unit: eventCount === 1 ? 'event' : 'events' };
    if (p === 'map') return { n: cityCount, unit: cityCount === 1 ? 'city' : 'cities' };
    if (p === 'ranking') return { n: artistCount, unit: artistCount === 1 ? 'artist' : 'artists' };
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
        <div className="space-y-1.5">
          <h1 className="font-display text-3xl font-normal tracking-tight text-text sm:text-4xl">
            {empty ? 'Start with the last show you remember' : 'Every show you\u2019ve ever been to, in one place.'}
          </h1>
          <p className="text-sm text-text-muted">
            Type one line about a show. LiveArchive finds the date, the venue and who played, and shows you where every detail came from.
          </p>
        </div>
        <CaptureBar
          onCaptured={onCaptured}
          label={empty ? 'A name is enough. You can add the rest later.' : undefined}
        />
        <div className="flex flex-wrap gap-4 text-sm">
          <button onClick={onImport} className="inline-flex min-h-11 items-center font-medium text-accent hover:underline sm:min-h-9">
            Import a list
          </button>
        </div>
      </section>

      {emailCheck && <EmailCard waiting={needs.email} onCheck={onReviewEmail} />}

      {yearReview && <YearTile review={yearReview} cities={yearCities} onOpen={() => onOpen('stats')} />}

      <FeatureTiles eventCount={eventCount} onOpen={onOpen} onImport={onImport} onShare={onShare} />

      {alerts.length > 0 && (
        <section className="space-y-2.5 rounded-card border border-warn/35 bg-surface-1 p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-warn">Needs you</h2>
          <div className="flex flex-wrap gap-2">
            {alerts.map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.key}
                  onClick={a.onClick}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line-strong bg-surface-2 px-3 py-1.5 text-sm text-text hover:border-warn/60 sm:min-h-9"
                >
                  <Icon className="h-3.5 w-3.5 text-warn" aria-hidden="true" /> {a.text}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {(Object.keys(SECTIONS) as Section[]).map((section) => (
        <section key={section} className="space-y-3">
          <h2 className="font-display text-xl font-normal text-text">{SECTIONS[section].label}</h2>
          <div className={`grid gap-3 sm:grid-cols-2 ${empty ? 'opacity-60' : ''}`}>
            {subPagesFor(section, { canManage }).map((p) => {
              const Icon = PAGE_ICON[p];
              const count = live(p);
              return (
                <button
                  key={p}
                  onClick={() => onOpen(p)}
                  className={`group flex items-center gap-4 rounded-card border p-4 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition duration-150 hover:-translate-y-0.5 hover:border-accent-tint-line hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.99] motion-reduce:transform-none motion-reduce:transition-none ${TINT[section]}`}
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-control border border-accent-tint-line bg-accent-tint text-accent transition duration-150 group-hover:scale-105 motion-reduce:transform-none">
                    <Icon className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-text">{PAGE_LABELS[p]}</span>
                    <span className="block text-sm text-text-muted">{PAGE_BLURB[p]}</span>
                  </span>
                  {count && (
                    <span className="shrink-0 text-right">
                      <span className="block text-3xl font-extrabold tabular-nums text-text">{count.n}</span>
                      <span className="block font-mono text-xs text-text-muted">{count.unit}</span>
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
