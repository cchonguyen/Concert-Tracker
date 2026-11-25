import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { placeLabel } from '../../services/format';
import { dateChip, RIVER_ZOOMS, riverLayout, RiverItem, riverStretch, TimelineSpan, TimelineViewProps } from '../../services/timeline';
import { Popover } from '../ui/Popover';

// River: events along a left-to-right time axis you drag or scroll, zoomed
// from about a decade down to a month. Concerts are dots, runs of days are
// bars, sized in steps by acts you logged (none logged draws like one act),
// with a line for today. Names show beside the marks once zoomed in. A mark
// opens a short list of the events on its days (hover with a mouse, tap on a
// touch screen, Enter on a keyboard); the marks also carry the browser's
// title as the screen-reader name. Only the large size is built so far.

const LANE = 26;
const AXIS = 24;

const ATTENDANCE_LABEL: Record<TimelineSpan['attendance'], string> = {
  went: 'Went',
  confirm: 'Did you go?',
  upcoming: 'Upcoming',
};

interface RiverProps extends TimelineViewProps {
  onShowInAgenda?: (eventId: string) => void; // "and N more": Agenda opens at this event
}

const MARK_CLASS = (item: RiverItem) => {
  if (item.span.attendance === 'confirm') return 'fill-transparent stroke-warn';
  if (item.span.attendance === 'upcoming') return 'fill-transparent stroke-accent';
  return item.span.kind === 'festival' ? 'fill-accent' : 'fill-accent-fill';
};

export const RiverView: React.FC<RiverProps> = ({ model, onOpen, onShowInAgenda }) => {
  const [zoom, setZoom] = useState(1);
  const layout = useMemo(() => riverLayout(model, RIVER_ZOOMS[zoom]), [model, zoom]);
  const box = useRef<HTMLDivElement>(null);
  const centre = useRef<number | null>(null); // the share of the width at the middle of the screen, kept across zooms
  const drag = useRef<{ x: number; left: number } | null>(null);
  const moved = useRef(false); // you scrolled or dragged; until then zooming stays on today

  // Open on today; after a zoom, keep the same moment in the middle.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !layout) return;
    const share = centre.current ?? layout.todayX / layout.width;
    el.scrollLeft = share * layout.width - el.clientWidth / 2;
  }, [layout]);

  const zoomTo = (next: number) => {
    const el = box.current;
    if (el && layout) centre.current = moved.current ? (el.scrollLeft + el.clientWidth / 2) / layout.width : layout.todayX / layout.width;
    setZoom(Math.max(0, Math.min(RIVER_ZOOMS.length - 1, next)));
  };

  if (!layout) return <p className="py-10 text-center text-sm text-text-muted">No dated events match these filters.</p>;
  const height = AXIS + Math.max(1, layout.lanes) * LANE + 8;
  const y = (lane: number) => AXIS + lane * LANE + LANE / 2;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>Drag or scroll sideways. Tap a mark to open it.</span>
        <span className="flex items-center gap-1">
          <button
            onClick={() => zoomTo(zoom - 1)}
            disabled={zoom === 0}
            aria-label="Zoom out"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-control border border-line-strong bg-surface-1 text-text-muted hover:border-accent-tint-line hover:text-text disabled:opacity-40 sm:min-h-9 sm:min-w-9"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => zoomTo(zoom + 1)}
            disabled={zoom === RIVER_ZOOMS.length - 1}
            aria-label="Zoom in"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-control border border-line-strong bg-surface-1 text-text-muted hover:border-accent-tint-line hover:text-text disabled:opacity-40 sm:min-h-9 sm:min-w-9"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <div
        ref={box}
        className="cursor-grab overflow-x-auto rounded-card border border-line-strong bg-surface-1 active:cursor-grabbing"
        onWheel={() => (moved.current = true)}
        onTouchStart={() => (moved.current = true)}
        onPointerDown={(e) => {
          moved.current = true;
          if (e.pointerType !== 'mouse' || (e.target as Element).closest('[data-mark]')) return;
          drag.current = { x: e.clientX, left: e.currentTarget.scrollLeft };
        }}
        onPointerMove={(e) => {
          if (drag.current) e.currentTarget.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        <div className="relative" style={{ width: layout.width, height }}>
        <svg width={layout.width} height={height} className="block select-none" role="img" aria-label="Events along a time axis">
          {layout.ticks.map((t) => (
            <g key={`${t.label}-${t.x}`}>
              <line x1={t.x} x2={t.x} y1={t.major ? 4 : 14} y2={height} className={t.major ? 'stroke-line-strong' : 'stroke-line'} strokeWidth={1} />
              <text x={t.x + 3} y={t.major ? 14 : 20} className={t.major ? 'fill-text-muted font-mono text-[11px] font-bold' : 'fill-text-faint font-mono text-[9px]'}>
                {t.label}
              </text>
            </g>
          ))}
          <line x1={layout.todayX} x2={layout.todayX} y1={4} y2={height} className="stroke-accent" strokeWidth={1.5} strokeDasharray="3 3" />
          <text x={layout.todayX + 3} y={height - 4} className="fill-accent font-mono text-[9px] font-bold uppercase">
            Today
          </text>
          {layout.items.map((item) => {
            const cy = y(item.lane);
            const outlined = item.span.attendance !== 'went';
            const common = {
              className: `${MARK_CLASS(item)} cursor-pointer hover:brightness-110`,
              strokeWidth: outlined ? 1.5 : 0,
              strokeDasharray: outlined ? '3 2' : undefined,
            };
            return (
              <g key={item.span.id}>
                <title>
                  {item.span.title}
                  {item.span.attendance === 'confirm' ? ' (did you go?)' : item.span.attendance === 'upcoming' ? ' (upcoming)' : ''}
                </title>
                {item.w > 0 ? (
                  <rect x={item.x} y={cy - item.r} width={Math.max(item.w, item.r * 2)} height={item.r * 2} rx={item.r} {...common} />
                ) : (
                  <circle cx={item.x + item.r} cy={cy} r={item.r} {...common} />
                )}
                {item.label && (
                  <text x={item.x + Math.max(item.w, item.r * 2) + 5} y={cy + 4} className="pointer-events-none fill-text text-[11px]">
                    {item.span.attendance === 'confirm' ? '? ' : ''}
                    {item.span.title}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
          {layout.items.map((item) => {
            const cy = y(item.lane);
            const pad = 4;
            const { shown, more } = riverStretch(model, item.span);
            return (
              <div
                key={item.span.id}
                data-mark
                className="absolute"
                style={{ left: item.x - pad, top: cy - item.r - pad, width: Math.max(item.w, item.r * 2) + pad * 2, height: item.r * 2 + pad * 2 }}
              >
                <Popover label={`${item.span.title}, ${dateChip(item.span)}`} className="h-full w-full" content={<Stretch shown={shown} more={more} onOpen={onOpen} onMore={() => onShowInAgenda?.(item.span.id)} />}>
                  <span className="block h-full w-full" />
                </Popover>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// The list under a mark: the events on its days, each one tap to open.
const Stretch: React.FC<{ shown: TimelineSpan[]; more: number; onOpen: (id: string) => void; onMore: () => void }> = ({ shown, more, onOpen, onMore }) => (
  <div className="space-y-1.5">
    <ul className="space-y-0.5">
      {shown.map((s) => {
        const place = placeLabel(s.event);
        return (
          <li key={s.id}>
            <button type="button" onClick={() => onOpen(s.id)} className="w-full rounded-control px-1.5 py-1 text-left hover:bg-surface-2">
              <span className="block truncate font-medium text-text">{s.title}</span>
              <span className="block truncate font-mono text-xs tabular-nums text-text-muted">
                {dateChip(s)}
                {place ? ` · ${place}` : ''}
              </span>
              <span className="block text-xs text-text-muted">{ATTENDANCE_LABEL[s.attendance]}</span>
            </button>
          </li>
        );
      })}
    </ul>
    {more > 0 && (
      <button type="button" onClick={onMore} className="px-1.5 text-xs font-medium text-accent hover:underline">
        and {more} more
      </button>
    )}
  </div>
);
