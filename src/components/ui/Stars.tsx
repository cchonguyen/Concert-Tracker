import { useState } from 'react';
import { Star } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

interface Props {
  value: number | null | undefined; // 1 to 5, or nothing when not rated
  // Without onChange the stars only show the rating.
  onChange?: (value: number | null) => void;
  size?: 'sm' | 'md';
  className?: string;
}

// A rating as icon stars with a label, never star characters
// (docs/specs/design-refresh-2.md, section 2). Unrated says "Not rated" to
// screen readers and shows faint outlines, so nothing reads as a rating that
// was not given. When editable, a tap on the current value clears it, and the
// chosen star and the ones before it pop in a quick ripple (skipped with reduced motion).
export function Stars({ value, onChange, size = 'sm', className = '' }: Props) {
  const still = useReducedMotion();
  const [popped, setPopped] = useState<number | null>(null);
  const rated = value ?? 0;
  const px = size === 'sm' ? 'h-[13px] w-[13px]' : 'h-5 w-5';
  const label = rated ? `Rated ${rated} of 5` : 'Not rated';

  if (!onChange) {
    return (
      <span role="img" aria-label={label} className={`inline-flex gap-px text-warn ${className}`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} className={`${px} ${rated ? (n <= rated ? '' : 'opacity-45') : 'opacity-30'}`} fill={n <= rated ? 'currentColor' : 'none'} strokeWidth={1.75} aria-hidden="true" />
        ))}
      </span>
    );
  }

  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex gap-0.5 text-warn ${className}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === rated}
          aria-label={`${n} of 5`}
          onClick={() => {
            const next = n === rated ? null : n;
            setPopped(next);
            onChange(next);
          }}
          className="flex min-h-11 min-w-9 items-center justify-center rounded-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:min-h-9 sm:min-w-8"
        >
          <motion.span
            animate={!still && popped !== null && n <= popped ? { scale: [1, 1.55, 1], rotate: [0, -14, 0] } : { scale: 1, rotate: 0 }}
            transition={{ duration: 0.36, ease: 'easeOut', delay: still ? 0 : (n - 1) * 0.05 }}
            className="inline-flex"
          >
            <Star className={`${px} ${n <= rated ? '' : 'opacity-45'}`} fill={n <= rated ? 'currentColor' : 'none'} strokeWidth={1.75} aria-hidden="true" />
          </motion.span>
        </button>
      ))}
    </div>
  );
}
