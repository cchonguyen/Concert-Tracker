import type { ReactNode } from 'react';

type Level = 1 | 2 | 3;
const SIZES: Record<'xl' | 'lg' | 'md', string> = {
  xl: 'text-[clamp(44px,7vw,72px)]',
  lg: 'text-[clamp(32px,5vw,48px)]',
  md: 'text-2xl sm:text-3xl',
};

interface Props {
  as?: Level;
  size?: keyof typeof SIZES;
  /** A word or phrase set in the second colour, after the main text (the landing page's "Every act."). */
  second?: ReactNode;
  className?: string;
  children: ReactNode;
}

// The landing page's loud headline (docs/specs/landing-look.md): condensed poster face, capitals.
export function PosterHeading({ as = 2, size = 'lg', second, className = '', children }: Props) {
  const Tag = `h${as}` as const;
  return (
    <Tag className={`poster-head text-text ${SIZES[size]} ${className}`}>
      {children}
      {second && <span className="text-second"> {second}</span>}
    </Tag>
  );
}
