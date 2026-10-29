import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, Menu, Sheet, UserCog, Users } from 'lucide-react';
import { Theme, ThemeControls } from './ThemePicker';
import { LogOutLink } from './LogOutLink';

interface Props {
  theme: Theme;
  canMembers: boolean; // owner of a multi-user install
  canAccount: boolean; // any multi-user install
  canSheets: boolean; // Google Sheets stays the owner's
  onMembers: () => void;
  onAccount: () => void;
  onImport: () => void;
  onExport: () => void; // every event, as CSV
  onSheets: () => void;
}

// One menu for everything about you and the app. A dropdown on desktop and a
// bottom sheet on phone; Theme sits inline in it.
export function MenuButton({ theme, canMembers, canAccount, canSheets, onMembers, onAccount, onImport, onExport, onSheets }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  const item = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800';

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Menu"
        aria-label="Menu"
        aria-expanded={open}
        className={`flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 transition-colors ${
          open ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        <Menu className="h-4 w-4" />
      </button>
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-40 space-y-4 rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 shadow-xl shadow-black/30 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-11 sm:w-64 sm:rounded-xl sm:border sm:p-3">
          {(canMembers || canAccount) && (
            <div className="space-y-1">
              {canAccount && (
                <button onClick={() => choose(onAccount)} className={item}>
                  <UserCog className="h-3.5 w-3.5" />
                  Your account
                </button>
              )}
              {canMembers && (
                <button onClick={() => choose(onMembers)} className={item}>
                  <Users className="h-3.5 w-3.5" />
                  Members
                </button>
              )}
            </div>
          )}
          <div className="space-y-1 border-t border-zinc-800 pt-3">
            <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Your data</p>
            <button onClick={() => choose(onImport)} className={item}>
              <FileUp className="h-3.5 w-3.5" />
              Import a list (CSV)
            </button>
            <button onClick={() => choose(onExport)} className={item}>
              <Download className="h-3.5 w-3.5" />
              Export all as CSV
            </button>
            {canSheets && (
              <button onClick={() => choose(onSheets)} className={item}>
                <Sheet className="h-3.5 w-3.5" />
                Google Sheets
              </button>
            )}
          </div>
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <p className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Theme</p>
            <ThemeControls theme={theme} />
          </div>
          <div className="border-t border-zinc-800 pt-3">
            <LogOutLink className={item} />
          </div>
        </div>
      )}
    </div>
  );
}
