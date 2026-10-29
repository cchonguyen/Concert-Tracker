import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';

export type NoticeTone = 'info' | 'success' | 'warning';

const TONES: Record<NoticeTone, { style: string; Icon: typeof Info }> = {
  info: { style: 'border-violet-500/30 bg-violet-500/10 text-violet-100', Icon: Info },
  success: { style: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100', Icon: CircleCheck },
  warning: { style: 'border-amber-500/40 bg-amber-500/10 text-amber-100', Icon: CircleAlert },
};

// A short, visible message for a result, a caveat or a warning. Warnings are announced at once; the rest are polite.
export function Notice({ tone = 'info', children, className = '' }: { tone?: NoticeTone; children: ReactNode; className?: string }) {
  const { style, Icon } = TONES[tone];
  return (
    <div
      role={tone === 'warning' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-card border px-3 py-2 text-sm ${style} ${className}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
