import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Pencil, type LucideIcon } from 'lucide-react';

export function ReadList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`divide-y divide-line rounded-none border border-line bg-surface-1 ${className}`}>
      {children}
    </div>
  );
}

interface ReadRowProps {
  id?: string;
  icon: LucideIcon;
  label: string;
  value?: ReactNode;
  emptyText?: string;
  mono?: boolean;
  source?: ReactNode;
  inferred?: ReactNode;
  flash?: boolean;
  alwaysOpen?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  editor?: (close: () => void) => ReactNode;
  below?: ReactNode;
  children?: ReactNode;
}

// A saved field shown as a quiet read row with its icon, label, value, and source.
// Tapping or pressing Enter swaps to the editor in place; leaving returns to read mode.
export function ReadRow({
  id,
  icon: Icon,
  label,
  value,
  emptyText = 'Not known yet',
  mono = false,
  source,
  inferred,
  flash = false,
  alwaysOpen = false,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  editor,
  below,
  children,
}: ReadRowProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const root = editorRef.current;
      if (!root) return;
      if (root.contains(document.activeElement)) return;
      const target = root.querySelector<HTMLElement>('input, textarea, select');
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const hasValue = value !== undefined && value !== null && value !== '';

  if (alwaysOpen) {
    return (
      <div id={id} className={`px-3 py-2.5 ${flash ? 'bg-good/5' : ''}`}>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 sm:min-h-10">
          <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
            <Icon className="h-4 w-4 shrink-0 text-text-muted" strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
          </div>
          <div className="min-w-0 flex-1 flex justify-end">{children}</div>
        </div>
        {below && <div className="mt-1.5 pl-6">{below}</div>}
      </div>
    );
  }

  if (isOpen && editor) {
    return (
      <div
        id={id}
        ref={editorRef}
        onBlur={() => {
          window.requestAnimationFrame(() => {
            if (editorRef.current && !editorRef.current.contains(document.activeElement)) {
              setOpen(false);
            }
          });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={`space-y-2 bg-surface-2/60 px-3 py-2.5 ${flash ? 'ring-1 ring-inset ring-good/60' : ''}`}
      >
        {editor(() => setOpen(false))}
        {below && <div className="pt-0.5">{below}</div>}
      </div>
    );
  }

  return (
    <div id={id} className={`px-3 py-1.5 ${flash ? 'ring-1 ring-inset ring-good/60' : ''}`}>
      {/* On phones the source drops under the value, so the value keeps the row's width. */}
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 sm:min-h-10 sm:flex-nowrap">
        <button
          type="button"
          disabled={disabled || !editor}
          aria-label={`Edit ${label}`}
          onClick={() => editor && !disabled && setOpen(true)}
          className="group flex min-h-11 min-w-0 flex-1 items-center gap-2.5 py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default sm:min-h-10"
        >
          <Icon className="h-4 w-4 shrink-0 text-text-muted" strokeWidth={1.75} aria-hidden="true" />
          <span className="w-20 shrink-0 text-xs font-medium text-text-muted sm:w-24">{label}</span>
          <span
            className={`min-w-0 flex-1 break-words text-sm ${mono ? 'font-mono tabular-nums' : ''} ${
              hasValue ? 'text-text' : 'text-text-faint'
            }`}
          >
            {hasValue ? value : emptyText}
          </span>
          {flash && <Check className="h-3.5 w-3.5 shrink-0 text-good" aria-label="Saved" />}
          {editor && !disabled && (
            <Pencil className="h-3.5 w-3.5 shrink-0 text-text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
          )}
        </button>

        {(source || inferred) && (
          <div className="flex w-full shrink-0 items-center gap-2 pb-1.5 pl-[26px] text-xs sm:w-auto sm:pb-0 sm:pl-0">
            {inferred}
            {source}
          </div>
        )}
      </div>
      {below && <div className="pb-1 pl-6">{below}</div>}
    </div>
  );
}
