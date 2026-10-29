import { useState, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  icon: LucideIcon;
  label: string; // Required: an icon alone is not a control until it has a name.
}

// An icon button with its name on hover (title) and for screen readers (aria-label).
// On a touch screen there is no hover, so tapping shows the name for a moment.
export function IconButton({ icon: Icon, label, className = '', onClick, onPointerDown, ...rest }: Props) {
  const [tapped, setTapped] = useState(false);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        title={label}
        aria-label={label}
        className={`flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${className}`}
        onPointerDown={(e) => {
          onPointerDown?.(e);
          if (e.pointerType === 'touch') {
            setTapped(true);
            window.setTimeout(() => setTapped(false), 1500);
          }
        }}
        onClick={onClick}
        {...rest}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
      {tapped && (
        <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100 shadow-lg">
          {label}
        </span>
      )}
    </span>
  );
}
