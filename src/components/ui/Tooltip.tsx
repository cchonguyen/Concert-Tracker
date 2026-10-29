import { useState, type ReactNode } from 'react';

interface Props {
  label: string;
  children: ReactNode;
  className?: string;
}

// A short name that appears on hover or keyboard focus. The control it wraps keeps its own accessible name,
// so the bubble is hidden from screen readers to avoid reading the name twice. On a touch screen, a tap shows it for a moment.
export function Tooltip({ label, children, className = '' }: Props) {
  const [tapped, setTapped] = useState(false);

  return (
    <span
      className={`group relative inline-flex ${className}`}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        setTapped(true);
        window.setTimeout(() => setTapped(false), 1500);
      }}
    >
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100 shadow-lg group-hover:block group-focus-within:block ${tapped ? 'block' : 'hidden'}`}
      >
        {label}
      </span>
    </span>
  );
}
