import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { tintHue } from '../services/eventTint';
import type { LoggedEvent, SeenAct, EventKind } from '../server/events/types';
import type { AttendanceState } from '../server/events/attendance';
import type { TicketFacts as ImportedFacts } from '../server/events/email/ticketFacts';
import type { InferredBilling } from '../server/canon/inferredBilling';
import { KIND_LABELS } from '../server/events/scale';
import { admitCount, barcodeBars, shortDate, shorthand, stubPieces, stubSentence, ticketLines, type StubPiece, type TicketAct } from '../services/ticket';
import type { Gap } from '../services/table';
import { Ticket, TicketEventLine, TicketHeadline, TicketKicker, TicketSmallLine, StubAdmit, StubBarcode, StubCode, StubKV, StubSentence, StubSerial, StubShortDate, StubStamp } from './ui/Ticket';
import { GAP_LABEL, gapQuestion } from '../services/poster';
import { NameList } from './ui/NameList';
import { Segmented } from './ui/Segmented';

export type TearState = 'idle' | 'tearing' | 'torn';

const WIDE = '(min-width: 640px)';

// Columns from 640px, rows on phones. Reads matchMedia so one ticket is rendered (no duplicate ids).
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

const money = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);

interface Props {
  title: string;
  dateLine: string; // The date as written, or "" when there is none.
  placeLine: string; // Venue and place on one line, or "".
  kind?: EventKind; // Your choice, or the one worked out in code. Absent when not known.
  event: LoggedEvent;
  state: AttendanceState;
  seen: SeenAct[];
  inferredBilling?: Record<string, InferredBilling>; // Inferred roles, shown with the "Inferred" label in the lineup.
  facts: ImportedFacts | null; // Seller, order and tickets from the ticket email, owner only.
  showNumber: number | null; // Your place among the shows you went to, when counted.
  tear: TearState;
  onWhoSaw: () => void; // Opens the Who you saw section.
}

// The top of the event detail: a true ticket. The body has the kicker, the big line (rules in src/services/ticket.ts),
// the date and the place. The stub end has only the pieces the event has, in the order docs/specs/ticket-stub.md gives.
export function PosterHeader({ title, dateLine, placeLine, kind, event, state, seen, inferredBilling = {}, facts, showNumber, tear, onWhoSaw }: Props) {
  const wide = useWide();
  const hue = tintHue(event.series, event.name);
  const lines = ticketLines(
    title,
    seen.map((s): TicketAct => (s.role ? { name: s.name, role: s.role } : { name: s.name, role: inferredBilling[s.key]?.role, inferred: Boolean(inferredBilling[s.key]) })),
  );
  const year = event.startDate?.match(/^\d{4}/)?.[0] ?? (event.year !== undefined ? String(event.year) : undefined);
  const kicker = [kind ? KIND_LABELS[kind] : '', year ?? ''].filter(Boolean);
  const moreText =
    lines.moreHeadliners > 0 ? `and ${lines.moreHeadliners} more ${lines.moreHeadliners === 1 ? 'headliner' : 'headliners'}` : '';
  const smallText =
    lines.small.length > 0 || moreText ? (
      <>
        <NameList names={lines.small} />
        {lines.small.length > 0 && moreText ? ', ' : ''}
        {moreText}
      </>
    ) : null;

  const parts = shortDate(event);
  const admit = event.peopleLocked ? Number.NaN : admitCount(event.companions);
  const factItems: Array<{ k: string; v: string }> = [];
  if (event.ticketPrice != null) factItems.push({ k: 'PRICE', v: money(event.ticketPrice) });
  if (facts?.orderLast4) factItems.push({ k: 'ORDER', v: `…${facts.orderLast4}` });
  if (facts?.seller) factItems.push({ k: 'SELLER', v: facts.seller });
  if (facts?.tickets != null) factItems.push({ k: 'TICKETS', v: String(facts.tickets) });

  // Room on the stub: five pieces in columns, five in rows. Pieces are cut from the end, so the Went stamp
  // shows before the show number and the shorthand.
  const room = 5;
  const pieces: StubPiece[] = stubPieces(
    { shortDate: parts !== null, ticketFacts: factItems.length > 0, went: state === 'went', showNumber: showNumber !== null },
    room,
  ).filter((p) => p !== 'admit' || !event.peopleLocked);

  const piece = (p: StubPiece) => {
    switch (p) {
      case 'admit':
        return <StubAdmit n={admit} big />;
      case 'shortDate':
        return parts ? <StubShortDate parts={parts} /> : null;
      case 'barcode':
        return <StubBarcode bars={barcodeBars(event.id)} height={wide ? 34 : 28} />;
      case 'ticketFacts':
        return <StubKV items={factItems} />;
      case 'went':
        return <StubStamp lines={['WENT']} />;
      case 'showNumber':
        return showNumber !== null ? <StubSerial text={`No. ${showNumber}`} /> : null;
      case 'shorthand':
        return <StubCode text={shorthand(title)} />;
    }
  };

  const sentence = stubSentence({
    admit,
    price: event.ticketPrice ?? undefined,
    went: state === 'went' && dateLine ? dateLine : undefined,
  });

  const body = (
    <>
      {kicker.length > 0 && <TicketKicker items={kicker} />}
      <TicketHeadline names={lines.big} />
      {lines.showEventLine && <TicketEventLine>{title}</TicketEventLine>}
      {smallText && <TicketSmallLine>{smallText}</TicketSmallLine>}
      {lines.askWhoSaw && (
        <button
          type="button"
          onClick={onWhoSaw}
          className="min-h-11 self-start text-sm font-semibold text-accent hover:underline sm:min-h-9"
        >
          Who did you see? ›
        </button>
      )}
      {dateLine && <TicketSmallLine>{dateLine}</TicketSmallLine>}
      {placeLine && <TicketSmallLine>{placeLine}</TicketSmallLine>}
    </>
  );

  const stub = (
    <>
      <div className={wide ? 'flex h-full flex-col justify-between gap-3' : 'flex flex-wrap items-center gap-x-5 gap-y-3'}>
        {pieces.map((p) => (
          <div key={p} className="flex min-w-0">
            {piece(p)}
          </div>
        ))}
      </div>
      {sentence && <StubSentence text={sentence} />}
    </>
  );

  return (
    <header className="poster-bg border-b border-line-strong px-5 pt-6 pb-5" style={hue == null ? undefined : ({ '--event-hue': hue } as CSSProperties)}>
      <h2 className="sr-only">{title}</h2>
      <Ticket
        layout={wide ? 'columns' : 'rows'}
        size="hero"
        label={`Ticket for ${title}`}
        body={body}
        stub={stub}
        tearing={tear === 'tearing'}
        torn={tear === 'torn'}
      />
    </header>
  );
}

interface StripProps {
  gaps: Gap[];
  current: Gap | null; // The gap being asked about; its question shows in the strip.
  needsWeekend?: boolean;
  onPick: (gap: Gap) => void;
  onNext: () => void;
}

// What the event still needs, on one line: the count, a chip per gap (the one being asked about is lit) and Next.
// Nothing left reads "All filled in".
export function ThingsLeft({ gaps, current, needsWeekend, onPick, onNext }: StripProps) {
  if (gaps.length === 0) {
    return (
      <p className="flex items-center gap-1.5 rounded-card border border-good/45 px-4 py-2.5 text-sm font-semibold text-good">
        <Check className="h-4 w-4" aria-hidden="true" /> All filled in
      </p>
    );
  }
  return (
    <section aria-label="Still to fill in" className="flex flex-wrap items-center gap-2 rounded-card border border-accent-tint-line bg-accent-tint px-3 py-2">
      <p className="text-sm font-semibold text-text">
        {gaps.length} {gaps.length === 1 ? 'thing' : 'things'} left
      </p>
      <span className="text-text-faint" aria-hidden="true">
        ·
      </span>
      <Segmented
        label="Things left"
        compact
        value={current ?? ''}
        onChange={(g) => onPick(g as typeof gaps[number])}
        options={gaps.map((g) => ({ value: g, label: GAP_LABEL[g] }))}
      />
      {current && <span className="min-w-0 text-sm text-text">{gapQuestion(current, { needsWeekend })}</span>}
      <span className="grow" />
      <button
        type="button"
        onClick={onNext}
        className="inline-flex min-h-11 items-center gap-0.5 rounded-control bg-accent-fill px-3 text-sm font-semibold text-on-accent hover:brightness-110 sm:min-h-9"
      >
        Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
