import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from './Tooltip';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  icon: LucideIcon;
  label: string; // Required: an icon alone is not a control until it has a name.
  // 'chip' is the height of a Pill, for icons that sit in a row of pills.
  size?: 'default' | 'chip';
}

// An icon button with its name shown on hover or focus (Tooltip) and read by screen readers (aria-label).
export function IconButton({ icon: Icon, label, size = 'default', className = '', ...rest }: Props) {
  const sizing = size === 'chip' ? 'h-[22px] w-[22px]' : 'h-11 w-11 sm:h-9 sm:w-9';
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className={`flex items-center justify-center rounded-control ${sizing} text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${className}`}
        {...rest}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
