import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, Lightbulb } from 'lucide-react';

export type NoticeTone = 'info' | 'success' | 'warning';

const TONES: Record<NoticeTone, { style: string; iconClass: string; Icon: typeof Info }> = {
  info: { style: 'border-line bg-surface-1 text-text-muted', iconClass: 'text-accent', Icon: Lightbulb },
  success: { style: 'border-good/45 bg-good/10 text-text', iconClass: 'text-good', Icon: CircleCheck },
  warning: { style: 'border-warn/45 bg-warn/10 text-text', iconClass: 'text-warn', Icon: CircleAlert },
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
