import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Lightbulb, TriangleAlert } from 'lucide-react';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

// Every tone shares one card. The tone only sets the icon tile: a solid fill with a matching dark or light icon.
const TONES: Record<NoticeTone, { tileClass: string; Icon: typeof Lightbulb }> = {
  info: { tileClass: 'bg-accent-fill text-on-accent', Icon: Lightbulb },
  success: { tileClass: 'bg-good text-surface-1', Icon: CircleCheck },
  warning: { tileClass: 'bg-warn text-on-warn', Icon: CircleAlert },
  error: { tileClass: 'bg-bad text-surface-1', Icon: TriangleAlert },
};

// A short, visible message for a result, a caveat, a warning or an error. Warnings and errors are announced at once; the rest are polite.
export function Notice({ tone = 'info', children, className = '' }: { tone?: NoticeTone; children: ReactNode; className?: string }) {
  const { tileClass, Icon } = TONES[tone];
  return (
    <div
      role={tone === 'warning' || tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-card border border-line bg-surface-2 px-3.5 py-2.5 text-sm text-text ${className}`}
    >
      <span className={`mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] ${tileClass}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
    </div>
  );
}
