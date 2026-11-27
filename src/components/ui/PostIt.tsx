import type { ReactNode } from 'react';

interface Props {
  /** Resting tilt in degrees; it straightens on hover. Keep it small (-3 to 3). */
  tilt?: number;
  tone?: 'paper' | 'second' | 'accent';
  icon?: ReactNode;
  title?: ReactNode;
  className?: string;
  /** Makes the whole note one button (a link card), with the usual focus ring. */
  onClick?: () => void;
  children?: ReactNode;
}

// A taped paper note for callouts and highlights (docs/specs/landing-look.md). Decorative motion only; the content reads the same without it.
export function PostIt({ tilt = 0, tone = 'paper', icon, title, className = '', onClick, children }: Props) {
  const Tag = onClick ? 'button' : 'div';
  const button = onClick
    ? ({ type: 'button', onClick, className: `postit block w-full p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-page ${className}` } as const)
    : { className: `postit p-5 ${className}` };
  return (
    <Tag {...button} data-tone={tone} style={{ ['--r' as string]: `${tilt}deg` }}>
      <span aria-hidden="true" className="postit-tape" />
      {icon && (
        <span aria-hidden="true" className="postit-icon mb-2 inline-flex">
          {icon}
        </span>
      )}
      {title && <div className="poster-head text-xl">{title}</div>}
      {children && <div className="mt-1.5 text-sm leading-relaxed">{children}</div>}
    </Tag>
  );
}
