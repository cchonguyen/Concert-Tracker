import React, { useEffect } from 'react';
import { PartyPopper, X } from 'lucide-react';
import { milestoneLine } from '../services/milestones';
import { Button } from './ui/Button';

const COLORS = ['#a78bfa', '#8b5cf6', '#c4b5fd', '#f4f4f5', '#fbbf24'];
const PIECES = 120;
const DURATION_MS = 2000;

// A short confetti burst on a full-screen canvas, removed when it ends. Written inline so no library is installed.
function burstConfetti() {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return () => undefined;
  }
  const pieces = Array.from({ length: PIECES }, () => ({
    x: canvas.width / 2,
    y: canvas.height * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 12 - 4,
    spin: Math.random() * Math.PI,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));
  const start = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.spin += 0.2;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      ctx.fillRect(-4, -2, 8, 4);
      ctx.restore();
    }
    if (elapsed < DURATION_MS) frame = window.requestAnimationFrame(tick);
    else canvas.remove();
  };
  frame = window.requestAnimationFrame(tick);
  return () => {
    window.cancelAnimationFrame(frame);
    canvas.remove();
  };
}

// Confetti runs once per card and never under reduced motion; the card alone is enough then.
export const MilestoneCard: React.FC<{ milestone: number; onSeeYear: () => void; onClose: () => void }> = ({ milestone, onSeeYear, onClose }) => {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    return burstConfetti();
  }, [milestone]);

  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,26rem)] -translate-x-1/2 items-start gap-3 rounded-2xl border border-violet-500/40 bg-zinc-900 p-4 shadow-xl">
      <PartyPopper className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-zinc-100">{milestoneLine(milestone)}</p>
        <Button variant="secondary" onClick={onSeeYear}>
          See your year
        </Button>
      </div>
      <button onClick={onClose} aria-label="Close" className="rounded-md p-2.5 text-zinc-400 hover:text-zinc-100">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
};
