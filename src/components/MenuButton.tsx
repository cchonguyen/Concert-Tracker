import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, Lightbulb, Menu, Share2, Sheet, UserCog, Users } from 'lucide-react';
import { Theme, ThemeControls } from './ThemePicker';
import { LogOutLink } from './LogOutLink';
import { IconButton } from './ui/IconButton';

interface Props {
  theme: Theme;
  canMembers: boolean; // owner of a multi-user install
  pendingRequests?: number; // requests waiting for the owner's answer, shown on Members
  canAccount: boolean; // any multi-user install
  canSheets: boolean; // Google Sheets stays the owner's
  onMembers: () => void;
  onAccount: () => void;
  onImport: () => void;
  onExport: () => void; // every event, as CSV
  onSheets: () => void;
  onShare: () => void;
  onShowTips: () => void;
}

// One menu for everything about you and the app. A dropdown on desktop and a
// bottom sheet on phone. Import, Export, Google Sheets and Share sit in one row
// of icons, and the theme modes in another, each icon with its name below.
export function MenuButton({ theme, canMembers, canAccount, canSheets, pendingRequests = 0, onMembers, onAccount, onImport, onExport, onSheets, onShare, onShowTips }: Props) {
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
  const actions = [
    { icon: FileUp, name: 'Import', label: 'Import a list (CSV)', run: onImport },
    { icon: Download, name: 'Export', label: 'Export all as CSV', run: onExport },
    ...(canSheets ? [{ icon: Sheet, name: 'Sheets', label: 'Google Sheets', run: onSheets }] : []),
    { icon: Share2, name: 'Share', label: 'Share', run: onShare },
  ];

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Menu"
        aria-expanded={open}
        className={`flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 transition-colors ${
          open ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        <Menu className="h-4 w-4" />
      </button>
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] space-y-4 overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 shadow-xl shadow-black/30 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-11 sm:max-h-none sm:w-64 sm:overflow-visible sm:rounded-xl sm:border sm:p-3">
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
                  {pendingRequests > 0 && <span className="ml-auto rounded-full bg-violet-500 px-1.5 text-[10px] text-white">{pendingRequests}</span>}
                </button>
              )}
            </div>
          )}
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <p className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-400">Your data</p>
            <div className="grid grid-cols-4 gap-1 sm:flex sm:items-center">
              {actions.map(({ icon: Icon, name, label, run }) => (
                <div key={name}>
                  {/* Phone: the icon and its name. Desktop: the icon alone, named on hover and focus. */}
                  <button
                    type="button"
                    onClick={() => choose(run)}
                    aria-label={label}
                    className="flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-xs text-zinc-300 hover:bg-zinc-800 sm:hidden"
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {name}
                  </button>
                  <div className="hidden sm:block">
                    <IconButton icon={Icon} label={label} onClick={() => choose(run)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <p className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-400">Theme</p>
            <ThemeControls theme={theme} />
          </div>
          <div className="border-t border-zinc-800 pt-3">
            <button onClick={() => choose(onShowTips)} className={item}>
              <Lightbulb className="h-3.5 w-3.5" />
              Show tips again
            </button>
            <LogOutLink className={item} />
          </div>
        </div>
      )}
    </div>
  );
}
