import { Dialog } from './ui/Dialog';
import React, { useEffect, useRef } from 'react';

import { Check, FileUp, Mail, Plus, X } from 'lucide-react';
import { CaptureBar } from './CaptureBar';
import { LoggedEvent } from '../services/lineupApi';

// Quick add: the same one-line capture, ticket email and list import, opened
// from any page as a popup. Saving closes the popup and shows a short "Saved".

interface QuickAddProps {
  open: boolean;
  onClose: () => void;
  onCaptured: (event: LoggedEvent) => void;
  onReviewEmail: () => void;
  onImport: () => void; // App opens the same Import as the Menu and the Table
  emailCheck: boolean;
}

export const QuickAdd: React.FC<QuickAddProps> = ({ open, onClose, onCaptured, onReviewEmail, onImport, emailCheck }) => {
  if (!open) return null;

  return (
    <Dialog title="Quick add" onClose={onClose} placement="center">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-zinc-100">Quick add</h2>
        <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-200">
          <X className="h-4 w-4" />
        </button>
      </div>
      <CaptureBar onCaptured={onCaptured} />
      <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
        {emailCheck && (
          <button
            onClick={() => {
              onClose();
              onReviewEmail();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            <Mail className="h-3.5 w-3.5" /> Check ticket email
          </button>
        )}
        <button onClick={onImport} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          <FileUp className="h-3.5 w-3.5" /> Import a list (CSV)
        </button>
      </div>
    </Dialog>
  );
};

// Header button, shown from the phone breakpoint up. Phones get the floating one below.
export const QuickAddButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    title="Quick add (N)"
    className="hidden items-center gap-1.5 rounded-xl bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 sm:inline-flex"
  >
    <Plus className="h-4 w-4" /> Quick add
  </button>
);

export const QuickAddFab: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    aria-label="Quick add"
    className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-violet-600 text-white shadow-lg shadow-black/40 sm:hidden"
  >
    <Plus className="h-6 w-6" />
  </button>
);

interface SavedToastProps {
  event: LoggedEvent;
  onOpen: (id: string) => void;
  onDismiss: () => void;
}

// Confirms a Quick Add save and lets you open it. Goes away on its own.
export const SavedToast: React.FC<SavedToastProps> = ({ event, onOpen, onDismiss }) => {
  // Keep the latest callback without restarting the timer on every parent render.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const t = setTimeout(() => dismiss.current(), 6000);
    return () => clearTimeout(t);
  }, [event.id]);

  return (
    <div role="status" className="fixed bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-200 shadow-xl sm:bottom-5">
      <Check className="h-4 w-4 text-emerald-400" />
      <span>Saved</span>
      <button
        onClick={() => {
          onOpen(event.id);
          onDismiss();
        }}
        className="font-semibold text-violet-300 hover:text-violet-200"
      >
        Open
      </button>
    </div>
  );
};
