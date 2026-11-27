import type { ReactNode } from 'react';

interface Props {
  /** Resting tilt in degrees; it straightens on hover. Keep it small (-3 to 3). */
  tilt?: number;
  tone?: 'paper' | 'second' | 'accent';
  icon?: ReactNode;
  title?: ReactNode;
  className?: string;
  children?: ReactNode;
}

// A taped paper note for callouts and highlights (docs/specs/landing-look.md). Decorative motion only; the content reads the same without it.
export function PostIt({ tilt = 0, tone = 'paper', icon, title, className = '', children }: Props) {
  return (
    <div className={`postit p-5 ${className}`} data-tone={tone} style={{ ['--r' as string]: `${tilt}deg` }}>
      <span aria-hidden="true" className="postit-tape" />
      {icon && (
        <span aria-hidden="true" className="postit-icon mb-2 inline-flex">
          {icon}
        </span>
      )}
      {title && <div className="poster-head text-xl">{title}</div>}
      {children && <div className="mt-1.5 text-sm leading-relaxed">{children}</div>}
    </div>
  );
}
