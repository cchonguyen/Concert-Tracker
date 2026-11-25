import { useEffect, useState } from 'react';
import App from './App';
import { SampleGateProvider } from './components/SampleGate';
import { Button } from './components/ui/Button';
import { meApi } from './services/lineupApi';
import { activateSample, startMode, type Start } from './services/sampleMode';

// Decides the mode before the app draws anything: the archive, sample mode, or
// an error screen. The app's first data call is only made after this settles.
type Boot = { phase: 'checking' } | { phase: 'error'; message: string } | { phase: 'ready'; start: Start };

export function Boot() {
  const [boot, setBoot] = useState<Boot>({ phase: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setBoot({ phase: 'checking' });
    startMode(window.location.pathname, () => meApi.get())
      .then(async (start) => {
        if (start.kind === 'error') {
          if (live) setBoot({ phase: 'error', message: start.message });
          return;
        }
        if (start.kind === 'sample') await activateSample(start);
        if (live) setBoot({ phase: 'ready', start });
      })
      .catch((err: unknown) => {
        if (live) setBoot({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  if (boot.phase === 'checking') return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  if (boot.phase === 'error')
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 text-text">
        <h1 className="font-display text-2xl font-normal">The server did not answer.</h1>
        <p className="text-sm text-text-muted">Nothing is shown until it does, so your archive is never swapped for sample data. ({boot.message})</p>
        <div>
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      </main>
    );

  return (
    <SampleGateProvider>
      <App initialMe={boot.start.kind === 'member' ? boot.start.me : undefined} />
    </SampleGateProvider>
  );
}

