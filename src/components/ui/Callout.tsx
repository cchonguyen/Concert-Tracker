import type { ReactNode } from 'react';
import { Lightbulb, X } from 'lucide-react';
import type { TipKey } from '../../services/tips';
import { useTip } from './TipsContext';

// A page tip: one quiet line under the page title (docs/specs/quiet-tips-table.md). It shows on the first
// visits, then folds into the ? in the header, which brings it back. Nothing renders until the account's
// choice has arrived, so a hidden tip never flashes back.
export function Callout({ id, children }: { id: TipKey; children: ReactNode }) {
  const { shown, entering, hide } = useTip(id);
  if (!shown) return null;
  return (
    <aside aria-label="Tip" className={`flex items-center gap-1.5 text-xs text-text-muted ${entering ? 'tip-enter' : ''}`}>
      <Lightbulb className="tip-bulb h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
      <p className="min-w-0 leading-snug">{children}</p>
      <button
        type="button"
        onClick={hide}
        aria-label="Hide this tip"
        className="-my-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-text-faint hover:bg-surface-2 hover:text-text sm:h-8 sm:w-8"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </aside>
  );
}
