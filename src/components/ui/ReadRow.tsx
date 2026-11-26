import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Info, Pencil, type LucideIcon } from 'lucide-react';
import { Popover } from './Popover';

export function ReadList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`divide-y divide-line rounded-none border border-line bg-surface-1 ${className}`}>
      {children}
    </div>
  );
}

// Every read row shares these columns, so icons, labels, values and the right-hand icons line up down the list:
// the row's icon, its label, the value, an optional action, and the right slot. From `sm` up the info icon sits
// beside the label and the right slot holds the edit icon (shown on hover). On phones a tap on the row edits it,
// so there is no edit icon and the info icon takes the right slot.
const COLUMNS = 'grid grid-cols-[1rem_4.5rem_minmax(0,1fr)_auto_1.5rem] items-center gap-x-1.5 sm:gap-x-2 sm:grid-cols-[1rem_6.5rem_minmax(0,1fr)_auto_1.75rem]';

interface ReadRowProps {
  id?: string;
  icon: LucideIcon;
  label: string;
  value?: ReactNode;
  emptyText?: string;
  mono?: boolean;
  // Where the value came from and any notes about it. It opens from a small icon beside the label, on hover or tap.
  info?: ReactNode;
  infoLabel?: string;
  flash?: boolean;
  // The value is its own control (choices, checkboxes), so the row is not one big edit button. With `editor`,
  // the edit icon on the right still opens it.
  alwaysOpen?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  editor?: (close: () => void) => ReactNode;
  // A small control just left of the edit slot, such as the Date row's "+".
  action?: ReactNode;
  below?: ReactNode;
  children?: ReactNode;
}

// A saved field shown as a quiet read row with its icon, label, value, and the edit icon at the right end.
// Tapping or pressing Enter swaps to the editor in place; leaving returns to read mode.
export function ReadRow({
  id,
  icon: Icon,
  label,
  value,
  emptyText = 'Not known yet',
  mono = false,
  info,
  infoLabel,
  flash = false,
  alwaysOpen = false,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  editor,
  action,
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
  const canEdit = Boolean(editor) && !disabled;

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

  const infoButton = (align: 'start' | 'end') => (
    <Popover align={align} label={infoLabel ?? `About ${label}`} content={<span className="block space-y-2 text-xs leading-relaxed text-text">{info}</span>}>
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-accent">
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Popover>
  );

  const valueText = (
    <span
      className={`block min-w-0 break-words text-sm ${mono ? 'tabular-nums sm:font-mono' : ''} ${hasValue ? 'text-text' : 'text-text-faint'}`}
    >
      {hasValue ? value : emptyText}
    </span>
  );

  return (
    <div id={id} className={`group ${COLUMNS} px-3 py-1 ${flash ? 'ring-1 ring-inset ring-good/60' : ''}`}>
      <Icon className="h-4 w-4 shrink-0 self-center text-text-muted" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-text-muted">
        <span className="min-w-0">{label}</span>
        {info && <span className="hidden sm:inline-flex">{infoButton('start')}</span>}
      </span>
      {alwaysOpen ? (
        <div className="min-w-0 py-1.5">{children}</div>
      ) : (
        <button
          type="button"
          disabled={!canEdit}
          aria-label={`Edit ${label}`}
          onClick={() => canEdit && setOpen(true)}
          className="flex min-h-11 min-w-0 items-center py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default sm:min-h-10"
        >
          {valueText}
        </button>
      )}
      <span className="flex items-center">{action}</span>
      <span className="flex items-center justify-end sm:hidden">{flash ? <Check className="h-3.5 w-3.5 text-good" aria-label="Saved" /> : info ? infoButton('end') : null}</span>
      <span className="hidden items-center justify-end sm:flex">
        {flash ? (
          <Check className="h-3.5 w-3.5 text-good" aria-label="Saved" />
        ) : canEdit ? (
          <button
            type="button"
            tabIndex={alwaysOpen ? 0 : -1}
            aria-hidden={alwaysOpen ? undefined : true}
            aria-label={alwaysOpen ? `Edit ${label}` : undefined}
            onClick={() => setOpen(true)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-control text-text-faint opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover:opacity-100`}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </span>
      {below && <div className="col-span-3 col-start-3 pb-1.5">{below}</div>}
    </div>
  );
}
