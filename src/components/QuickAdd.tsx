import { Dialog } from './ui/Dialog';
import React from 'react';

import { FileUp, Mail, Plus, X } from 'lucide-react';
import { IconButton } from './ui/IconButton';
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
        <h2 className="poster-head text-2xl text-text">Quick add</h2>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      <CaptureBar onCaptured={onCaptured} />
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {emailCheck && (
          <button
            onClick={() => {
              onClose();
              onReviewEmail();
            }}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text-muted hover:bg-surface-2 hover:text-text sm:min-h-9"
          >
            <Mail className="h-3.5 w-3.5" /> Check ticket email
          </button>
        )}
        <button onClick={onImport} className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text-muted hover:bg-surface-2 hover:text-text sm:min-h-9">
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
    className="hidden min-h-9 items-center gap-1.5 rounded-control bg-accent-fill px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-fill sm:inline-flex"
  >
    <Plus className="h-4 w-4" /> Quick add
  </button>
);

export const QuickAddFab: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    aria-label="Quick add"
    className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent-fill text-on-accent shadow-lg shadow-black/40 sm:hidden"
  >
    <Plus className="h-6 w-6" />
  </button>
);
