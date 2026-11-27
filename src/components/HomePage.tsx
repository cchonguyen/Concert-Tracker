import React from 'react';
import { PosterHeading } from './ui/PosterHeading';
import { PostIt } from './ui/PostIt';
import { Mail, Search, Ticket } from 'lucide-react';
import { CaptureBar } from './CaptureBar';
import { PAGE_ICON } from './pageIcons';
import { Page, Section, SECTIONS, STRIP_BLURB, STRIP_LABELS, StripTab, stripTabsFor } from '../services/nav';
import { LoggedEvent } from '../services/lineupApi';
import { EmailCard } from './EmailCard';
import { FeatureTiles } from './FeatureTiles';
import { YearTile } from './YearTile';
import { Ticket as TicketCard, TicketEventLine, TicketHeadline, TicketKicker, TicketSmallLine, StubBarcode, StubShortDate } from './ui/Ticket';
import type { YearReview } from '../services/stats';
import { barcodeBars, shortDate, ticketLines, type TicketAct } from '../services/ticket';
import { placeLabel, whenLabel } from '../services/format';
import { NameList } from './ui/NameList';

interface HomePageProps {
  canManage: boolean;
  eventCount: number;
  cityCount: number;
  artistCount: number;
  yearReview: YearReview | null;
  yearCities: number;
  yearMonths: number[]; // shows per month this year, Jan to Dec
  lastShow: LoggedEvent | null;
  onThisDay: LoggedEvent | null;
  today: string; // YYYY-MM-DD
  onOpenEvent: (id: string) => void;
  needs: { confirm: number; email: number; researching: number };
  emailCheck: boolean;
  onCaptured: (event: LoggedEvent) => void;
  onImport: () => void;
  onReviewEmail: () => void;
  onOpenSummary: () => void;
  onOpenTimeline: () => void;
  onOpen: (page: Page) => void;
}

// What each page is for, in one friendly line.

// The page links are post-its (docs/specs/landing-look.md): tilts repeat in this order, tones alternate per section.
const LINK_TILTS = [-1, 1.25, 0.75, -1.25, -0.5, 1];
const LINK_TONES: Record<Section, readonly ['paper' | 'second' | 'accent', 'paper' | 'second' | 'accent']> = {
  library: ['paper', 'second'],
  explore: ['accent', 'paper'],
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// A small ticket for one show on Home. Only the name, acts (with stored roles), date and place.
function SmallShowTicket({
  event,
  kicker,
  onOpen,
}: {
  event: LoggedEvent;
  kicker: string;
  onOpen: (id: string) => void;
}) {
  const acts: TicketAct[] = event.seen.map((s) => ({ name: s.name, role: s.role }));
  const lines = ticketLines(event.name, acts);
  const parts = shortDate(event);
  const where = [whenLabel(event), placeLabel(event)].filter(Boolean).join(' · ');
  const body = (
    <>
      <TicketKicker items={[kicker]} />
      <TicketHeadline names={lines.big} />
      {lines.showEventLine && <TicketEventLine>{event.name}</TicketEventLine>}
      {(lines.small.length > 0 || lines.moreHeadliners > 0) && (
        <TicketSmallLine>
          <NameList names={lines.small} />
          {lines.small.length > 0 && lines.moreHeadliners > 0 && ' · '}
          {lines.moreHeadliners > 0 && `+${lines.moreHeadliners} more`}
        </TicketSmallLine>
      )}
      {where && <TicketSmallLine>{where}</TicketSmallLine>}
    </>
  );
  const stub = (
    <div className="flex h-full flex-col justify-between gap-3">
      {parts && <StubShortDate parts={parts} />}
      <StubBarcode bars={barcodeBars(event.id)} height={28} />
    </div>
  );
  return (
    <div className="group relative">
      <TicketCard layout="columns" size="small" label={`Ticket for ${event.name}`} body={body} stub={stub} />
      <button
        type="button"
        onClick={() => onOpen(event.id)}
        className="absolute inset-0 rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="sr-only">Open {event.name}</span>
      </button>
    </div>
  );
}

// The landing page: the add box, what needs you, and one card per page.
export const HomePage: React.FC<HomePageProps> = ({
  canManage,
  eventCount,
  cityCount,
  artistCount,
  yearReview,
  yearCities,
  yearMonths,
  lastShow,
  onThisDay,
  today,
  onOpenEvent,
  needs,
  emailCheck,
  onCaptured,
  onImport,
  onReviewEmail,
  onOpenSummary,
  onOpenTimeline,
  onOpen,
}) => {
  const yearsAgo = onThisDay ? Number(today.slice(0, 4)) - Number(onThisDay.startDate!.slice(0, 4)) : 0;
  const empty = eventCount === 0;
  const live = (t: StripTab): { n: number; unit: string } | null => {
    if (t === 'summary') return { n: eventCount, unit: eventCount === 1 ? 'event' : 'events' };
    if (t === 'timeline') return { n: eventCount, unit: eventCount === 1 ? 'show' : 'shows' };
    if (t === 'map') return { n: cityCount, unit: cityCount === 1 ? 'city' : 'cities' };
    if (t === 'ranking') return { n: artistCount, unit: artistCount === 1 ? 'artist' : 'artists' };
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
          <PosterHeading as={1} size="xl" second={empty ? 'the last show you remember' : 'In one place.'}>
            {empty ? 'Start with' : 'Every show you\u2019ve ever been to.'}
          </PosterHeading>
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

      {yearReview && <YearTile review={yearReview} cities={yearCities} months={yearMonths} onOpen={() => onOpen('stats')} />}

      {(lastShow || onThisDay) && (
        <div className={`grid gap-3 ${lastShow && onThisDay ? 'sm:grid-cols-2' : ''}`}>
          {lastShow && <SmallShowTicket event={lastShow} kicker="Last show" onOpen={onOpenEvent} />}
          {onThisDay && (
            <SmallShowTicket
              event={onThisDay}
              kicker={`On this day · ${yearsAgo === 1 ? '1 year ago' : `${yearsAgo} years ago`}`}
              onOpen={onOpenEvent}
            />
          )}
        </div>
      )}

      <FeatureTiles onOpen={onOpen} onImport={onImport} />

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
          <PosterHeading size="md">{SECTIONS[section].label}</PosterHeading>
          <div className={`grid gap-5 pt-2 sm:grid-cols-2 ${empty ? 'opacity-60' : ''}`}>
            {stripTabsFor(section, { canManage }).map((t, i) => {
              const Icon = PAGE_ICON[t === 'timeline' ? 'agenda' : t];
              const count = live(t);
              return (
                <PostIt
                  key={t}
                  onClick={() => (t === 'timeline' ? onOpenTimeline() : onOpen(t))}
                  tilt={LINK_TILTS[i % LINK_TILTS.length]}
                  tone={LINK_TONES[section][i % 2]}
                  className="h-full"
                >
                  <span className="flex items-center gap-4">
                    <span aria-hidden="true" className="postit-icon flex h-11 w-11 shrink-0 items-center justify-center">
                      <Icon className="h-7 w-7" strokeWidth={2} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="poster-head block text-2xl">{STRIP_LABELS[t]}</span>
                      <span className="mt-0.5 block text-sm">{STRIP_BLURB[t]}</span>
                    </span>
                    {count && (
                      <span className="shrink-0 text-right">
                        <span className="poster-head block text-4xl tabular-nums">{count.n}</span>
                        <span className="block font-mono text-xs">{count.unit}</span>
                      </span>
                    )}
                  </span>
                </PostIt>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
};
