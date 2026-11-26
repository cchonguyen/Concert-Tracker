import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { Equalizer } from './Equalizer';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  icon: LucideIcon;
  label: string; // Required: an icon alone is not a control until it has a name.
  // 'chip' is the height of a Pill, for icons that sit in a row of pills.
  size?: 'default' | 'chip';
  // Shows the music bars in place of the icon while its work runs.
  busy?: boolean;
}

// An icon button with its name shown on hover or focus (Tooltip) and read by screen readers (aria-label).
export function IconButton({ icon: Icon, label, size = 'default', busy = false, className = '', ...rest }: Props) {
  // Close buttons stay 40 px from 640 px up (design-refresh-2.md, section 5); other icon buttons are 36 px there.
  const sizing = size === 'chip' ? 'h-[22px] w-[22px]' : label === 'Close' ? 'h-11 w-11 sm:h-10 sm:w-10' : 'h-11 w-11 sm:h-9 sm:w-9';
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-busy={busy || undefined}
        className={`icon-wiggle flex items-center justify-center rounded-control ${sizing} text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${className}`}
        {...rest}
      >
        {busy ? <Equalizer size="sm" /> : <Icon className="h-4 w-4" aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}
