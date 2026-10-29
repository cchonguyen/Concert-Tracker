import { useEffect, useState } from 'react';
import { accessRequestsApi } from '../services/lineupApi';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';

// Shown to a signed-in account with no tracker here (the server's 403 with
// code "not_invited"). It shows the verified email and the ask, and nothing
// else: no data, no counts. A banned account sees the same "Request sent" as a
// pending one, so the screen never says which it is.

type View = 'loading' | 'none' | 'sent' | 'closed';

export function NotInvited({ email }: { email: string }) {
  const [view, setView] = useState<View>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    accessRequestsApi.mine().then((r) => setView(r.state), () => setView('none'));
  }, []);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setView((await accessRequestsApi.ask()).state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-5 px-4 py-10">
      <h1 className="text-xl font-bold text-zinc-100">This account is not invited.</h1>
      <p className="text-sm text-zinc-400">
        You are signed in as <span className="break-all text-zinc-200">{email}</span>. This tracker is invite-only.
      </p>
      {view === 'none' && (
        <div className="space-y-2">
          <Button variant="primary" onClick={ask} disabled={busy}>
            Request access
          </Button>
          <p className="text-xs text-zinc-500">The owner sees your request and decides.</p>
        </div>
      )}
      {view === 'sent' && <Notice tone="success">Request sent.</Notice>}
      {view === 'closed' && <Notice tone="warning">Requests are closed for now. Try again later.</Notice>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <a href="/cdn-cgi/access/logout" className="text-sm text-violet-300 underline">
        Sign out / switch account
      </a>
    </main>
  );
}
