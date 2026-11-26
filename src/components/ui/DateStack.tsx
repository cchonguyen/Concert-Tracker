import { whenLabel } from '../../services/format';
import { tableDate } from '../../services/table';
import type { LoggedEvent } from '../../services/lineupApi';

// A date stacked in a narrow column for phone rows: day, month and year on their own lines, then the weekday or
// the number of days. The full date is in the tooltip.
export function DateStack({ e }: { e: Pick<LoggedEvent, 'startDate' | 'endDate' | 'year' | 'month'> }) {
  const d = tableDate(e);
  if (!d) return <span className="block text-center font-mono text-[11px] italic leading-tight text-text-muted">No date</span>;
  const short = d.day ? d.note?.split(',')[0] : undefined;
  return (
    <div title={whenLabel(e) ?? undefined} className="flex flex-col items-center font-mono leading-tight tabular-nums">
      {d.day && <span className="text-base font-semibold text-text">{d.day}</span>}
      {d.month && <span className="text-[11px] font-medium uppercase text-text">{d.month}</span>}
      <span className="text-[11px] text-text-muted">{d.year}</span>
      {short && <span className="mt-0.5 text-[10px] text-text-muted">{short}</span>}
    </div>
  );
}
