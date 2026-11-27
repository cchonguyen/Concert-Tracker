import { useState } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';

interface Props {
  title: string; // Also the dialog's name for screen readers.
  message: string;
  confirmLabel: string; // Names the action, e.g. "Delete show". Never "OK".
  typedMatch?: string; // When set, the confirm button stays disabled until this exact text is typed.
  onConfirm: () => void;
  onCancel: () => void;
}

// For actions that cannot be undone. Reversible actions act at once and offer Undo in a toast instead.
export function Confirm({ title, message, confirmLabel, typedMatch, onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState('');
  const ready = typedMatch === undefined || typed.trim() === typedMatch;
  return (
    <Dialog title={title} onClose={onCancel} placement="center">
      <h2 className="poster-head text-2xl text-text">{title}</h2>
      <p className="text-sm text-text-muted">{message}</p>
      {typedMatch !== undefined && (
        <label className="block space-y-1 text-xs text-text-muted">
          Type <span className="font-mono text-text">{typedMatch}</span> to confirm
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="min-h-11 w-full rounded-control border border-line-strong bg-page px-3 py-2 text-sm text-text sm:min-h-9"
          />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!ready} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
