import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from './Tooltip';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  icon: LucideIcon;
  label: string; // Required: an icon alone is not a control until it has a name.
}

// An icon button with its name shown on hover or focus (Tooltip) and read by screen readers (aria-label).
export function IconButton({ icon: Icon, label, className = '', ...rest }: Props) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className={`flex h-11 w-11 items-center justify-center rounded-control sm:h-9 sm:w-9 text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${className}`}
        {...rest}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
