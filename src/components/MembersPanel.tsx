import { Dialog } from './ui/Dialog';
import React, { useEffect, useState } from 'react';
import { Loader2, Trash2, UserPlus, X } from 'lucide-react';
import { Confirm } from './ui/Confirm';
import { membersApi, type MemberRow } from '../services/lineupApi';

// The owner's invite list (multi-user only). An invited person signs in with
// Cloudflare Access using the same email, so add them in Access too. Removing
// someone deletes their account and every event they saved.

const button = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';

export const MembersPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = () => membersApi.list().then(setMembers, (e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    load();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Members" onClose={onClose} panelClassName="h-full w-full max-w-md space-y-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Members</h2>
        <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-200">
          <X className="h-5 w-5" />
        </button>
      </div>
      <p className="text-xs text-zinc-400">
        Each member keeps their own events, imports and share link. Nobody, you included, sees another member's events here. Add the same email in
        Cloudflare Access so they can sign in.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            await membersApi.invite(email);
            setEmail('');
          });
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="friend@example.com"
          className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
        />
        <button type="submit" disabled={busy || !email.trim()} className={button}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Invite
        </button>
      </form>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {members === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      ) : (
        <ul className="space-y-2">
          {members.map((m) => (
            <li key={m.email} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate text-zinc-100">{m.email}</p>
                <p className="text-[11px] text-zinc-400">{m.role === 'owner' ? 'Owner' : m.joined ? 'Member' : 'Invited, not signed in yet'}</p>
              </div>
              {m.role !== 'owner' && (
                <button
                  disabled={busy}
                  onClick={() => setRemoving(m.email)}
                  aria-label={`Remove ${m.email}`}
                  className="text-zinc-400 hover:text-rose-300 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <Confirm
          title="Remove member"
          message="Their account and every event they saved are deleted. This cannot be undone."
          confirmLabel="Remove member"
          typedMatch={removing}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const who = removing;
            setRemoving(null);
            void act(() => membersApi.remove(who));
          }}
        />
      )}
    </Dialog>
  );
};
