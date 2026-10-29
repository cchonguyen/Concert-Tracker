import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';

export interface ToastOptions {
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
}

type ShowToast = (options: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

// How long a toast stays before it leaves on its own.
const LIFETIME_MS = 6000;
// Newest toasts are kept; older ones are dropped so a burst cannot cover the page.
const MAX_SHOWN = 3;

// Mount once at the root. Every toast is announced politely by the live region below.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  const show = useCallback<ShowToast>(
    (options) => {
      const id = ++nextId.current;
      setItems((prev) => [...prev.slice(-(MAX_SHOWN - 1)), { ...options, id }]);
      setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-5">
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-200 shadow-xl"
          >
            <Check className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
            <span className="min-w-0">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="shrink-0 font-semibold text-violet-300 hover:text-violet-200"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Returns a function that shows a toast, e.g. toast({ message: 'Exported 214 shows as CSV' }).
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside ToastProvider');
  return show;
}
