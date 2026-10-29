import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MONTH_NAMES, MonthSegment, monthPage, shiftMonth, spanInRange, TimelineViewProps, WEEKDAY_SHORT } from '../../services/timeline';
import { eventTitle } from '../../services/series';

// Month: a calendar page. One-day events sit in their day; a run of days is a
// bar across them, with the days you went solid and the ones you skipped
// faint. Arrows and the pickers move the page and report it up, so the
// address keeps the month. Only the large size is built so far.

const SEGMENT_STYLE: Record<MonthSegment['span']['attendance'], { went: string; skipped: string; text: string }> = {
  went: { went: 'bg-violet-600/80', skipped: 'bg-violet-600/25', text: 'text-white' },
  upcoming: { went: 'border border-dashed border-violet-400/70', skipped: 'border border-dashed border-violet-400/30', text: 'text-violet-200' },
  confirm: { went: 'border border-dashed border-amber-400/70', skipped: 'border border-dashed border-amber-400/30', text: 'text-amber-200' },
};

const Segment: React.FC<{ seg: MonthSegment; onOpen: (id: string) => void }> = ({ seg, onOpen }) => {
  const style = SEGMENT_STYLE[seg.span.attendance];
  const title = eventTitle(seg.span.event);
  return (
    <button
      onClick={() => onOpen(seg.span.id)}
      title={title}
      style={{ gridColumn: `${seg.start + 1} / span ${seg.len}`, gridRow: seg.lane + 2 }}
      className={`relative flex h-5 min-w-0 overflow-hidden text-left text-[11px] font-medium leading-5 ${style.text} ${
        seg.before ? 'rounded-l-none' : 'rounded-l-md'
      } ${seg.after ? 'rounded-r-none' : 'rounded-r-md'} mx-px hover:brightness-125`}
    >
      {/* One piece per day, so a festival day you skipped shows faint. */}
      <span className="absolute inset-0 flex" aria-hidden>
        {seg.days.map((d) => (
          <span key={d.date} className={`flex-1 ${d.went ? style.went : style.skipped}`} />
        ))}
      </span>
      <span className="relative truncate px-1.5">
        {seg.span.attendance === 'confirm' && '? '}
        {seg.before ? '… ' : ''}
        {title}
      </span>
    </button>
  );
};

export const MonthView: React.FC<TimelineViewProps> = ({ model, range, onRangeChange, onOpen }) => {
  const today = model.today;
  const at = range.kind === 'month' ? range : { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const page = useMemo(() => monthPage(model, at.year, at.month), [model, at.year, at.month]);
  const go = (next: { year: number; month: number }) => onRangeChange?.({ kind: 'month', ...next });
  const years = useMemo(() => {
    const ys = new Set([Number(today.slice(0, 4)), at.year, ...model.spans.map((s) => Number(s.first.slice(0, 4))), ...model.partial.map((p) => p.year)]);
    return [...ys].sort((a, b) => b - a);
  }, [model, today, at.year]);
  const count = model.spans.filter((s) => spanInRange(s, { kind: 'month', ...at })).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button onClick={() => go(shiftMonth(at.year, at.month, -1))} aria-label="Previous month" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="min-w-40 text-center text-lg font-extrabold tracking-tight text-zinc-200">
            {MONTH_NAMES[at.month - 1]} {at.year}
          </h2>
          <button onClick={() => go(shiftMonth(at.year, at.month, 1))} aria-label="Next month" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
            <ChevronRight className="h-4 w-4" />
          </button>
          <span className="ml-2 text-xs text-zinc-400">
            {count} event{count === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <select
            value={at.month}
            onChange={(e) => go({ year: at.year, month: Number(e.target.value) })}
            aria-label="Month"
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-100"
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name.slice(0, 3)}
              </option>
            ))}
          </select>
          <select
            value={at.year}
            onChange={(e) => go({ year: Number(e.target.value), month: at.month })}
            aria-label="Year"
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-100"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            onClick={() => go({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) })}
            className="rounded-lg border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-600"
          >
            Today
          </button>
        </div>
      </div>

      {page.undayed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
          <span className="font-semibold text-zinc-400">This month, day unknown:</span>
          {page.undayed.map((p) => (
            <button key={p.id} onClick={() => onOpen(p.id)} className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:border-zinc-500">
              {p.title}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <div className="grid grid-cols-7 border-b border-zinc-800 bg-zinc-900/60 text-center text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
          {WEEKDAY_SHORT.map((d) => (
            <div key={d} className="py-1.5">
              {d}
            </div>
          ))}
        </div>
        {page.weeks.map((week) => (
          <div key={week.days[0].date} className="relative border-b border-zinc-800/70 last:border-b-0">
            {/* Day squares behind, events on lanes in front. */}
            <div className="absolute inset-0 grid grid-cols-7" aria-hidden>
              {week.days.map((d) => (
                <div key={d.date} className={`border-r border-zinc-800/50 last:border-r-0 ${d.inMonth ? '' : 'bg-zinc-900/50'}`} />
              ))}
            </div>
            <div className="relative grid min-h-20 grid-cols-7 content-start gap-y-1 pb-2" style={{ gridTemplateRows: `auto repeat(${week.lanes}, 1.25rem)` }}>
              {week.days.map((d, i) => (
                <div key={d.date} style={{ gridColumn: i + 1, gridRow: 1 }} className="px-1.5 pt-1 text-right text-xs">
                  <span
                    className={
                      d.date === today
                        ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 font-bold text-white'
                        : d.inMonth
                          ? 'text-zinc-400'
                          : 'text-zinc-700'
                    }
                  >
                    {Number(d.date.slice(8))}
                  </span>
                </div>
              ))}
              {week.segments.map((seg) => (
                <Segment key={`${seg.span.id}-${week.days[0].date}`} seg={seg} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
