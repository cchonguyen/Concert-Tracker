import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { placeLabel } from '../../services/format';
import { dateChip, RIVER_ZOOMS, riverLayout, RiverItem, riverStretch, TimelineSpan, TimelineViewProps } from '../../services/timeline';
import { Popover } from '../ui/Popover';

// River: events along a vertical top-to-bottom time axis you drag or scroll
// through, zoomed from about a decade down to a month, with a light grid in
// the background. Concerts are dots, runs of days are vertical bars, sized in
// steps by acts you logged (none logged draws like one act), with a line for
// today. Names show beside the marks once zoomed in. A mark opens a short list
// of the events on its days (hover with a mouse, tap on a touch screen, Enter
// on a keyboard); the marks also carry the browser's title as the screen-reader
// name. Only the large size is built so far.

const AXIS_X = 76;
const PAD_Y = 20;
const GRID_SIZE = 24;

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
  const gridId = useId();
  const layout = useMemo(() => riverLayout(model, RIVER_ZOOMS[zoom]), [model, zoom]);
  const box = useRef<HTMLDivElement>(null);
  const centre = useRef<number | null>(null); // the share of the height at the middle of the screen, kept across zooms
  const drag = useRef<{ y: number; top: number } | null>(null);
  const moved = useRef(false); // you scrolled or dragged; until then zooming stays on today

  const totalHeight = layout ? layout.width + PAD_Y * 2 : 0;

  // Open on today; after a zoom, keep the same moment in the middle.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !layout) return;
    const share = centre.current ?? (PAD_Y + layout.todayX) / totalHeight;
    el.scrollTop = share * totalHeight - el.clientHeight / 2;
  }, [layout, totalHeight]);

  const zoomTo = (next: number) => {
    const el = box.current;
    if (el && layout) {
      centre.current = moved.current
        ? (el.scrollTop + el.clientHeight / 2) / totalHeight
        : (PAD_Y + layout.todayX) / totalHeight;
    }
    setZoom(Math.max(0, Math.min(RIVER_ZOOMS.length - 1, next)));
  };

  if (!layout) return <p className="py-10 text-center text-sm text-text-muted">No dated events match these filters.</p>;

  const hasLabels = layout.items.some((i) => i.label);
  const laneStep = hasLabels ? 176 : 36;
  const minWidth = AXIS_X + 24 + Math.max(1, layout.lanes) * laneStep + (hasLabels ? 140 : 40);
  const laneX = (lane: number) => AXIS_X + 24 + lane * laneStep;
  const todayY = PAD_Y + layout.todayX;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>Drag or scroll up and down. Tap a mark to open it.</span>
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
        className="h-[65vh] min-h-[420px] max-h-[760px] cursor-grab overflow-x-auto overflow-y-auto rounded-card border border-line-strong bg-surface-1 active:cursor-grabbing"
        onWheel={() => (moved.current = true)}
        onTouchStart={() => (moved.current = true)}
        onPointerDown={(e) => {
          moved.current = true;
          if (e.pointerType !== 'mouse' || (e.target as Element).closest('[data-mark]')) return;
          drag.current = { y: e.clientY, top: e.currentTarget.scrollTop };
        }}
        onPointerMove={(e) => {
          if (drag.current) e.currentTarget.scrollTop = drag.current.top - (e.clientY - drag.current.y);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        <div className="relative w-full" style={{ minWidth, height: totalHeight }}>
          <svg
            width="100%"
            height={totalHeight}
            style={{ minWidth }}
            className="block select-none"
            role="img"
            aria-label="Events along a vertical time axis"
          >
            <defs>
              <pattern id={gridId} width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
                <path
                  d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`}
                  fill="none"
                  className="stroke-line"
                  strokeWidth={1}
                  strokeOpacity={0.35}
                />
              </pattern>
            </defs>
            <rect x={AXIS_X} y={0} width="100%" height={totalHeight} fill={`url(#${gridId})`} />
            <line x1={AXIS_X} x2={AXIS_X} y1={0} y2={totalHeight} className="stroke-line" strokeWidth={1} />
            {layout.ticks.map((t) => {
              const ty = PAD_Y + t.x;
              return (
                <g key={`${t.label}-${t.x}`}>
                  <line
                    x1={AXIS_X}
                    x2="100%"
                    y1={ty}
                    y2={ty}
                    className={t.major ? 'stroke-line-strong' : 'stroke-line'}
                    strokeWidth={1}
                  />
                  <text
                    x={AXIS_X - 8}
                    y={ty + 4}
                    textAnchor="end"
                    className={t.major ? 'fill-text-muted font-mono text-[11px] font-bold' : 'fill-text-faint font-mono text-[9px]'}
                  >
                    {t.label}
                  </text>
                </g>
              );
            })}
            <line x1={AXIS_X} x2="100%" y1={todayY} y2={todayY} className="stroke-accent" strokeWidth={1.5} strokeDasharray="3 3" />
            <text x={AXIS_X - 8} y={todayY - 4} textAnchor="end" className="fill-accent font-mono text-[9px] font-bold uppercase">
              Today
            </text>
            {layout.items.map((item) => {
              const cy = PAD_Y + item.x;
              const cx = laneX(item.lane);
              const barH = Math.max(item.w, item.r * 2);
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
                    <rect x={cx - item.r} y={cy} width={item.r * 2} height={barH} rx={item.r} {...common} />
                  ) : (
                    <circle cx={cx} cy={cy + item.r} r={item.r} {...common} />
                  )}
                  {item.label && (
                    <text x={cx + item.r + 8} y={cy + item.r + 4} className="pointer-events-none fill-text text-[11px]">
                      {item.span.attendance === 'confirm' ? '? ' : ''}
                      {item.span.title}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {layout.items.map((item) => {
            const cy = PAD_Y + item.x;
            const cx = laneX(item.lane);
            const barH = Math.max(item.w, item.r * 2);
            const pad = 4;
            const { shown, more } = riverStretch(model, item.span);
            return (
              <div
                key={item.span.id}
                data-mark
                className="absolute"
                style={{ left: cx - item.r - pad, top: cy - pad, width: item.r * 2 + pad * 2, height: barH + pad * 2 }}
              >
                <Popover
                  label={`${item.span.title}, ${dateChip(item.span)}`}
                  className="h-full w-full"
                  content={<Stretch shown={shown} more={more} onOpen={onOpen} onMore={() => onShowInAgenda?.(item.span.id)} />}
                >
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
