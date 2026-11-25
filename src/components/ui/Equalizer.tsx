import { motion, useReducedMotion } from 'motion/react';

// The busy mark: three bars that breathe while a lookup or save is running,
// in place of a spinner (docs/specs/design-refresh-2.md, section 4, Breathe).
// With reduced motion the bars stand still. Give the surrounding text the
// words ("Finding who played"); the mark itself is hidden from screen readers.
const BARS = [
  [0.55, 1, 0.4],
  [1, 0.45, 0.85],
  [0.35, 0.8, 0.55],
];

export function Equalizer({ size = 'md', className = '' }: { size?: 'sm' | 'md'; className?: string }) {
  const still = useReducedMotion();
  const h = size === 'sm' ? 11 : 14;
  return (
    <span aria-hidden="true" className={`inline-flex items-end gap-0.5 ${className}`} style={{ height: h }}>
      {BARS.map((frames, i) => (
        <motion.span
          key={i}
          className="w-0.5 origin-bottom rounded-[1px] bg-current"
          style={{ height: h }}
          initial={{ scaleY: frames[0] }}
          animate={still ? { scaleY: frames[0] } : { scaleY: frames }}
          transition={still ? { duration: 0 } : { duration: 0.9, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut', delay: i * 0.12 }}
        />
      ))}
    </span>
  );
}
