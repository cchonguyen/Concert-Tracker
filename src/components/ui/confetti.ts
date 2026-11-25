import { prefersReducedMotion } from '../../services/motion';

// The confetti burst shared by the milestone card and the event detail. Written inline so no library is installed.
const COLOR_VARS = ['--la-accent', '--la-accent-fill', '--accent-300', '--la-warn', '--la-text'];
const PIECES = 120;
const DURATION_MS = 2000;

function readPalette(): string[] {
  const styles = getComputedStyle(document.documentElement);
  const colors = COLOR_VARS.map((v) => styles.getPropertyValue(v).trim()).filter(Boolean);
  if (colors.length > 0) return colors;
  const fallback = styles.color.trim();
  return fallback ? [fallback] : ['CanvasText'];
}

export function burstConfetti() {
  if (prefersReducedMotion()) return () => undefined;
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
  const palette = readPalette();
  const pieces = Array.from({ length: PIECES }, () => ({
    x: canvas.width / 2,
    y: canvas.height * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 12 - 4,
    spin: Math.random() * Math.PI,
    color: palette[Math.floor(Math.random() * palette.length)],
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
