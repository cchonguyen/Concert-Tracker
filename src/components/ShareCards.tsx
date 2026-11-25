import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LoggedEvent } from '../server/events/types';
import { cardContent, cardEvents, cardFileName, cardText, type CardContent, type CardOptions } from '../services/shareCard';
import { whenLabel } from '../services/format';
import { stubPiecesShared } from '../services/ticket';

// Event cards: pick a show you went to, choose what shows, and save the card
// as a PNG. The card is drawn here in the browser; nothing is sent to the
// server. Private fields never reach CardContent, so they are never drawn.

const W = 1200;
const H = 630;
const PERF_X = 860;
const MARGIN = 40;

interface Palette {
  page: string;
  paper: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  display: string;
  sans: string;
  mono: string;
}

// Canvas ignores colour strings it cannot parse (color-mix() from the CSS vars
// is one), so each value is tested on a probe and falls back when it is not usable.
let probe: CanvasRenderingContext2D | null = null;
function usableColour(value: string): string | null {
  if (!value) return null;
  if (!probe) probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.fillStyle = '#000000';
  probe.fillStyle = value;
  return probe.fillStyle === '#000000' && value.trim().toLowerCase() !== '#000000' ? null : value;
}

function palette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const colour = (name: string, fallback: string) => usableColour(cs.getPropertyValue(name).trim()) ?? fallback;
  const font = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    page: colour('--la-page', '#0e0e11'),
    paper: colour('--la-paper', '#1a1a1f'),
    ink: colour('--la-text', '#ededf0'),
    muted: colour('--la-text-muted', '#a1a1aa'),
    line: colour('--la-line-strong', '#3d3d46'),
    accent: colour('--la-accent', '#fbbf24'),
    display: font('--font-display', 'Newsreader, ui-serif, Georgia, serif'),
    sans: font('--font-sans', 'system-ui, sans-serif'),
    mono: font('--font-mono', 'ui-monospace, Menlo, monospace'),
  };
}

// Words wrapped to maxW, as lines.
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (!cur || ctx.measureText(trial).width <= maxW) cur = trial;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// At most maxLines lines; the last one gets an ellipsis when text is cut.
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines = wrap(ctx, text, maxW);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

function drawCard(canvas: HTMLCanvasElement, c: CardContent, p: Palette): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = W;
  canvas.height = H;

  // Backdrop, then the ticket body, notched at the perforation.
  ctx.fillStyle = p.page;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = p.paper;
  ctx.beginPath();
  ctx.roundRect(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, 18);
  ctx.fill();

  const notch = (y: number) => {
    ctx.fillStyle = p.page;
    ctx.beginPath();
    ctx.arc(PERF_X, y, 22, 0, Math.PI * 2);
    ctx.fill();
  };
  notch(MARGIN);
  notch(H - MARGIN);

  ctx.save();
  ctx.strokeStyle = p.line;
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 10]);
  ctx.beginPath();
  ctx.moveTo(PERF_X, MARGIN + 26);
  ctx.lineTo(PERF_X, H - MARGIN - 26);
  ctx.stroke();
  ctx.restore();

  // Body.
  const bodyX = MARGIN + 56;
  const bodyW = PERF_X - bodyX - 60;
  let y = MARGIN + 80;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = p.muted;
  ctx.font = `600 24px ${p.mono}`;
  ctx.fillText(c.kicker.toUpperCase(), bodyX, y);

  const bigText = c.big.join(' & ');
  // The largest size at which the big line fits in two lines (or the smallest, cut with an ellipsis).
  let bigSize = 44;
  for (const size of [84, 68, 56, 44]) {
    bigSize = size;
    ctx.font = `600 ${size}px ${p.display}`;
    if (wrap(ctx, bigText, bodyW).length <= 2) break;
  }
  ctx.font = `600 ${bigSize}px ${p.display}`;
  const bigLines = fit(ctx, bigText, bodyW, 2);
  ctx.fillStyle = p.ink;
  y += 110;
  for (const line of bigLines) {
    ctx.fillText(line, bodyX, y);
    y += bigSize * 1.05;
  }

  if (c.eventLine) {
    ctx.font = `italic 400 34px ${p.display}`;
    ctx.fillStyle = p.ink;
    for (const line of fit(ctx, c.eventLine, bodyW, 1)) {
      ctx.fillText(line, bodyX, y + 6);
      y += 44;
    }
  }

  if (c.small) {
    ctx.font = `400 28px ${p.sans}`;
    ctx.fillStyle = p.muted;
    for (const line of fit(ctx, c.small, bodyW, 2)) {
      y += 6;
      ctx.fillText(line, bodyX, y + 30);
      y += 36;
    }
  }

  const footer = [c.when, c.where].filter(Boolean).join(' · ');
  if (footer) {
    ctx.font = `400 26px ${p.sans}`;
    ctx.fillStyle = p.muted;
    const lines = fit(ctx, footer, bodyW, 2);
    lines.forEach((line, i) => ctx.fillText(line, bodyX, H - MARGIN - 70 + i * 34));
  }

  // Stub end: only the pieces that are shared (never admit or ticket facts).
  const stubX = PERF_X + 40;
  const stubW = W - MARGIN - 40 - stubX;
  const pieces = stubPiecesShared({ shortDate: Boolean(c.stub.shortDate), went: c.stub.went }, 4);
  const centre = stubX + stubW / 2;

  if (pieces.includes('shortDate') && c.stub.shortDate) {
    const parts = c.stub.shortDate;
    const boxW = 72;
    const gap = 10;
    const total = parts.length * boxW + (parts.length - 1) * gap;
    let bx = centre - total / 2;
    ctx.font = `600 34px ${p.mono}`;
    ctx.textAlign = 'center';
    for (const part of parts) {
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, MARGIN + 80, boxW, 64);
      ctx.fillStyle = p.ink;
      ctx.fillText(part, bx + boxW / 2, MARGIN + 125);
      bx += boxW + gap;
    }
    ctx.textAlign = 'left';
  }

  if (pieces.includes('went')) {
    ctx.save();
    ctx.translate(centre, 300);
    ctx.rotate(-0.16);
    ctx.font = `700 76px ${p.display}`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(-120, -62, 240, 96);
    ctx.fillStyle = p.accent;
    ctx.fillText('WENT', 0, 14);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  if (pieces.includes('shorthand')) {
    ctx.font = `600 34px ${p.mono}`;
    ctx.fillStyle = p.ink;
    ctx.textAlign = 'center';
    ctx.fillText(c.stub.code, centre, 420);
    ctx.textAlign = 'left';
  }

  if (pieces.includes('barcode')) {
    const unit = 1.5;
    const total = c.stub.bars.reduce((sum, b) => sum + b * unit, 0);
    let bx = centre - total / 2;
    ctx.fillStyle = p.ink;
    c.stub.bars.forEach((b, i) => {
      if (i % 2 === 0) ctx.fillRect(bx, 452, b * unit, 90);
      bx += b * unit;
    });
  }
}

export const ShareCards: React.FC<{ events: LoggedEvent[]; today: string; sample?: () => void }> = ({ events, today, sample }) => {
  const cards = useMemo(() => cardEvents(events, today), [events, today]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opts, setOpts] = useState<CardOptions>({ acts: true, exactDates: true, venue: true });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const selected = cards.find((e) => e.id === selectedId) ?? cards[0];
  const content = useMemo(() => (selected ? cardContent(selected, opts) : null), [selected, opts]);

  useEffect(() => {
    if (!content) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      drawCard(canvas, content, palette());
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (cards.length === 0) {
    return (
      <div role="region" aria-label="Event cards">
        <p className="text-sm text-text-muted">Cards are for shows you went to. Once you mark one as went, it shows up here.</p>
      </div>
    );
  }

  const save = () => {
    if (sample) {
      sample();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || !selected) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = cardFileName(selected);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  };

  const toggle = (key: keyof CardOptions) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setOpts((o) => ({ ...o, [key]: e.target.checked }));

  const box = 'inline-flex min-h-11 items-center gap-2 text-sm text-text sm:min-h-9';

  return (
    <div className="space-y-4" role="region" aria-label="Event cards">
      <div className="space-y-2">
        <label htmlFor="share-card-event" className="block text-sm text-text-muted">
          Event
        </label>
        <select
          id="share-card-event"
          value={selected?.id}
          onChange={(e) => setSelectedId(e.target.value)}
          className="min-h-11 w-full rounded-control border border-line-strong bg-surface-2 px-3 text-sm text-text sm:min-h-9"
        >
          {cards.map((e) => (
            <option key={e.id} value={e.id}>
              {`${e.name} · ${whenLabel(e) ?? 'undated'}`}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
        <legend className="mb-1 text-sm text-text-muted">What shows on the card</legend>
        <label className={box}>
          <input type="checkbox" checked={opts.acts} onChange={toggle('acts')} /> Who you saw
        </label>
        <label className={box}>
          <input type="checkbox" checked={opts.exactDates} onChange={toggle('exactDates')} /> Exact dates
        </label>
        <label className={box}>
          <input type="checkbox" checked={opts.venue} onChange={toggle('venue')} /> Venue
        </label>
      </fieldset>

      {content && (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={cardText(content)}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          className="rounded-card border border-line"
        />
      )}

      <button
        type="button"
        onClick={save}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line-strong bg-surface-2 px-3 py-1.5 text-sm text-text hover:border-warn/60 sm:min-h-9"
      >
        Save image
      </button>
    </div>
  );
};
