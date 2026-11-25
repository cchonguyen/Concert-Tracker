import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { prefersReducedMotion } from '../../services/motion';

const MARKS = 6;
const MOVE_MS = 1000;

// A small ring of marks that bursts from the middle of its relative parent each time `trigger` changes.
// Nothing shows on mount, and nothing shows at all when reduced motion is set.
export function Burst({ icon: Icon, trigger }: { icon: LucideIcon; trigger: number }) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!trigger || prefersReducedMotion()) return;
    setLive(true);
    const t = window.setTimeout(() => setLive(false), MOVE_MS);
    return () => window.clearTimeout(t);
  }, [trigger]);
  if (!live) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
      {/* The wrappers place each mark; the animation on the icon itself must not fight their transforms. */}
      {Array.from({ length: MARKS }, (_, i) => (
        <span key={i} className="absolute inset-0 flex items-start justify-center" style={{ transform: `rotate(${(360 / MARKS) * i}deg)` }}>
          <span className="mt-[18%]">
            <Icon className="motion-safe:animate-ping h-3 w-3 text-accent" />
          </span>
        </span>
      ))}
    </span>
  );
}
