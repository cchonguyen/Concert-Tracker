import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, Lightbulb } from 'lucide-react';

export type NoticeTone = 'info' | 'success' | 'warning';

const TONES: Record<NoticeTone, { style: string; iconClass: string; Icon: typeof Info }> = {
  info: { style: 'border-zinc-800/80 bg-zinc-900/50 text-zinc-300', iconClass: 'text-violet-300/80', Icon: Lightbulb },
  success: { style: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100', iconClass: 'text-emerald-300', Icon: CircleCheck },
  warning: { style: 'border-amber-500/40 bg-amber-500/10 text-amber-100', iconClass: 'text-amber-300', Icon: CircleAlert },
};

// A short, visible message for a result, a caveat or a warning. Warnings are announced at once; the rest are polite.
export function Notice({ tone = 'info', children, className = '' }: { tone?: NoticeTone; children: ReactNode; className?: string }) {
  const { style, iconClass, Icon } = TONES[tone];
  return (
    <div
      role={tone === 'warning' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-card border px-3.5 py-2.5 text-sm ${style} ${className}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
    </div>
  );
}
