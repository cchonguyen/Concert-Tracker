import { useState } from 'react';
import { accessRequestsApi } from '../../services/lineupApi';
import { Button } from './Button';

// The one explainer for a save control in sample mode. A tap on Add, Import,
// an event's edit, a lookup and so on opens it. It says what the button does in
// your archive and offers the way in: Log in (signed out) or Request access (not invited).

export const DEMO_ACTIONS: Record<string, string> = {
  add: "In your archive, typing 'Portola 2025' looks up the real dates, venue and lineup from real sources, and you tick the acts you saw.",
  import: 'In your archive, Import reads a list of past shows you kept elsewhere and lets you check each row before anything is saved.',
  email: 'In your archive, Check email looks through your Gmail for ticket mail from the sellers the app can read, and puts what it finds on a list for you to tick.',
  lookup: 'In your archive, Look up lineup asks the sources for the acts on this event and shows where each one came from.',
  share: 'In your archive, Share makes a read-only page of your history with a link you can switch off.',
  sheets: 'In your archive, Google Sheets keeps a one-way copy of your log in a sheet you choose.',
  manage: 'In your archive, Manage is where you rename, merge and tidy your artists, venues and series.',
  edit: 'In your archive, you edit an event by changing its fields here; nothing you change is saved in the sample.',
};

const GENERIC = 'In your archive, this button saves something to your own log. Nothing is saved in the sample.';

export function DemoPrompt({ action, notInvited, onBack }: { action?: string; notInvited: boolean; onBack: () => void }) {
  const [state, setState] = useState<'idle' | 'sent' | 'closed' | 'error'>('idle');
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true);
    try {
      const r = await accessRequestsApi.ask();
      setState(r.state === 'closed' ? 'closed' : 'sent');
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm text-zinc-200">
      <p>{(action && DEMO_ACTIONS[action]) || GENERIC}</p>
      <div className="flex flex-wrap items-center gap-2">
        {notInvited ? (
          state === 'sent' ? (
            <span className="text-zinc-300">Your request is in.</span>
          ) : state === 'closed' ? (
            <span className="text-zinc-300">Requests are closed for now.</span>
          ) : (
            <Button variant="primary" onClick={ask} disabled={busy}>
              Request access
            </Button>
          )
        ) : (
          <a href="/app" className="rounded-lg bg-violet-500 px-3 py-1.5 font-medium text-white">
            Log in (invite only)
          </a>
        )}
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      </div>
      {state === 'error' && <p className="text-xs text-rose-300">The request did not go through. Try again.</p>}
    </div>
  );
}
