import { useEffect, useState } from 'react';
import { accessRequestsApi } from '../services/lineupApi';
import type { SampleMode } from '../services/sampleMode';
import { Button } from './ui/Button';

// The strip above a sample-mode page. Signed out on /demo: "Log in (invite
// only)". Signed in on /demo: "Go to your archive". Signed in and not invited:
// the verified email with Request access and switch account. The request
// screen never says whether a request is pending or was declined.

type Ask = 'loading' | 'none' | 'sent' | 'closed';

export function SampleBanner({ mode, email, signedIn }: { mode: SampleMode; email: string | null; signedIn: boolean }) {
  const [ask, setAsk] = useState<Ask>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'not-invited') return;
    accessRequestsApi.mine().then((r) => setAsk(r.state), () => setAsk('none'));
  }, [mode]);

  if (mode === 'demo') {
    return (
      <div role="note" className="flex flex-wrap items-center justify-between gap-2 bg-violet-600/20 px-4 py-2 text-sm">
        <span>Sample data. Nothing here is real.</span>
        <a href="/app" className="font-medium text-violet-200 underline">
          {signedIn ? 'Go to your archive →' : 'Log in (invite only)'}
        </a>
      </div>
    );
  }

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setAsk((await accessRequestsApi.ask()).state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="note" className="flex flex-wrap items-center justify-between gap-2 bg-violet-600/20 px-4 py-2 text-sm">
      <span>
        Signed in as <span className="break-all font-medium">{email}</span>. This account isn't invited yet. Sample data only.
      </span>
      <span className="flex flex-wrap items-center gap-3">
        {ask === 'none' && (
          <Button variant="primary" onClick={request} disabled={busy}>
            Request access
          </Button>
        )}
        {ask === 'sent' && <span className="text-violet-100">Your request is in.</span>}
        {ask === 'closed' && <span className="text-violet-100">Requests are closed for now.</span>}
        <a href="/cdn-cgi/access/logout" className="font-medium text-violet-200 underline">
          Switch account
        </a>
      </span>
      {error && <p className="w-full text-xs text-rose-300">{error}</p>}
    </div>
  );
}
