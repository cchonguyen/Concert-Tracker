import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-fill font-semibold text-on-accent hover:brightness-110',
  secondary: 'border border-line-strong bg-surface-2 text-text hover:bg-surface-3',
  ghost: 'text-text-muted hover:bg-surface-2 hover:text-text',
  danger: 'border border-bad/45 bg-bad/10 text-bad hover:bg-bad/20',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// The one text button. It lifts and grows a little on hover and presses in when tapped (landing-look.md; never a tilt), not under reduced motion. It defaults to type="button" so a button inside a form never submits it by accident.
export function Button({ variant = 'secondary', type = 'button', className = '', ...rest }: Props) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-control px-3 py-1.5 text-sm btn-pop focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
