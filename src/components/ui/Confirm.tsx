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
      <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
      <p className="text-sm text-zinc-400">{message}</p>
      {typedMatch !== undefined && (
        <label className="block space-y-1 text-xs text-zinc-400">
          Type <span className="font-mono text-zinc-200">{typedMatch}</span> to confirm
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded-control border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
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
