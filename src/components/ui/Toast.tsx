import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

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
  const still = useReducedMotion();

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
        <AnimatePresence initial={false}>
        {items.map((t) => (
          // Toasts rise into place and fade out (design-refresh-2.md, section 4); instant with reduced motion.
          <motion.div
            key={t.id}
            layout={!still}
            initial={still ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={still ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 6, transition: { duration: 0.15 } }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            className="pointer-events-auto flex max-w-full items-center gap-3 rounded-card border border-line-strong bg-surface-2 px-4 py-2.5 text-sm text-text shadow-xl shadow-black/30"
          >
            <Check className="h-4 w-4 shrink-0 text-good" aria-hidden="true" />
            <span className="min-w-0">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="inline-flex min-h-11 shrink-0 items-center font-semibold text-accent hover:underline sm:min-h-9"
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
        </AnimatePresence>
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
