import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { isNotInvited, isSampleMode, setBlockedWriteHandler } from '../services/sampleMode';
import { Dialog } from './ui/Dialog';
import { DemoPrompt } from './ui/DemoPrompt';

// Sample mode's write gate. A save control calls ask(action) instead of saving;
// a write that gets past every control lands in the same explainer (the
// blocked-write handler in lineupApi), so one dialog serves them all.

interface SampleGateValue {
  readOnly: boolean;
  ask: (action?: string) => void;
}

const SampleGateContext = createContext<SampleGateValue>({ readOnly: false, ask: () => undefined });

export function SampleGateProvider({ children }: { children: ReactNode }) {
  const [action, setAction] = useState<string | null>(null);
  const readOnly = isSampleMode();
  const ask = useCallback((next?: string) => setAction(next ?? ''), []);

  useEffect(() => {
    if (!readOnly) return;
    setBlockedWriteHandler(ask);
    return () => setBlockedWriteHandler(null);
  }, [readOnly, ask]);

  return (
    <SampleGateContext.Provider value={{ readOnly, ask }}>
      {children}
      {action !== null && (
        <Dialog title="Sample data" onClose={() => setAction(null)} placement="center">
          <DemoPrompt action={action || undefined} notInvited={isNotInvited()} onBack={() => setAction(null)} />
        </Dialog>
      )}
    </SampleGateContext.Provider>
  );
}

export const useSampleGate = () => useContext(SampleGateContext);
