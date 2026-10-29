import { Dialog } from './ui/Dialog';
import React, { useState } from 'react';
import { Download, Lock, Unlock, X } from 'lucide-react';
import { accountApi } from '../services/lineupApi';
import { hasCiphertext, type ExportBundle } from '../services/exportBundle';
import { useMe } from './MeContext';
import { useVault } from './VaultContext';
import { LogOutLink } from './LogOutLink';

// Multi-user only: the private-notes vault and "Download / delete my data".
// The recovery key is shown once and the server never sees it.

const button = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';
const field = 'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100';

export const AccountPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const me = useMe();
  const vault = useVault();
  const [passphrase, setPassphrase] = useState('');
  const [next, setNext] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      if (message) setDone(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // The export is opened in this browser: the server only has notes and people encrypted.
  const downloadReadable = async () => {
    if (vault.status === 'locked') throw new Error('Unlock your vault first, or download the encrypted copy.');
    const res = await fetch(accountApi.exportUrl);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (HTTP ${res.status}).`);
    let bundle = (await res.json()) as ExportBundle;
    if (vault.status === 'unlocked' && hasCiphertext(bundle)) bundle = await vault.openExport(bundle);
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'liveArchive-export.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const secret = () => (useRecovery ? { recoveryKey: passphrase } : { passphrase });

  return (
    <Dialog title="Your account" onClose={onClose} panelClassName="h-full w-full max-w-md space-y-5 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Your account</h2>
        <button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-200">
          <X className="h-5 w-5" />
        </button>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {done && <p className="text-xs text-emerald-300">{done}</p>}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Private notes</h3>
        {vault.status === 'unavailable' || vault.status === 'loading' ? (
          <p className="text-xs text-zinc-500">Not available.</p>
        ) : vault.status === 'off' && !recoveryKey ? (
          <>
            <p className="text-xs text-zinc-500">
              Encrypts your notes in this browser, so the server (and the owner) only ever stores unreadable text. Lose both the passphrase and the recovery key and the notes are gone.
            </p>
            <input type="password" className={field} placeholder="Passphrase (8+ characters)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <button
              className={button}
              disabled={busy || passphrase.length < 8}
              onClick={() =>
                act(async () => {
                  setRecoveryKey(await vault.setUp(passphrase));
                  setPassphrase('');
                })
              }
            >
              <Lock className="h-3.5 w-3.5" /> Turn on private notes
            </button>
          </>
        ) : recoveryKey ? (
          <>
            <p className="text-xs text-amber-300">Save this recovery key somewhere safe. It is shown once and is the only way back in if you forget the passphrase.</p>
            <code className="block select-all break-all rounded-lg bg-zinc-900 p-3 text-xs">{recoveryKey}</code>
            <button className={button} onClick={() => setRecoveryKey(null)}>
              I have saved it
            </button>
          </>
        ) : vault.status === 'locked' ? (
          <>
            <input
              type="password"
              className={field}
              placeholder={useRecovery ? 'Recovery key' : 'Passphrase'}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className={button}
                disabled={busy || !passphrase}
                onClick={() =>
                  act(async () => {
                    await vault.unlock(secret());
                    setPassphrase('');
                  })
                }
              >
                <Unlock className="h-3.5 w-3.5" /> Unlock
              </button>
              <button className={button} onClick={() => setUseRecovery(!useRecovery)}>
                {useRecovery ? 'Use passphrase' : 'Use recovery key'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-emerald-300">Unlocked in this tab. Reloading locks it again.</p>
            <button className={button} onClick={() => vault.lock()}>
              <Lock className="h-3.5 w-3.5" /> Lock now
            </button>
            <input type="password" className={field} placeholder="Current passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <input type="password" className={field} placeholder="New passphrase" value={next} onChange={(e) => setNext(e.target.value)} />
            <button
              className={button}
              disabled={busy || !passphrase || next.length < 8}
              onClick={() =>
                act(async () => {
                  await vault.changePassphrase({ passphrase }, next);
                  setPassphrase('');
                  setNext('');
                }, 'Passphrase changed.')
              }
            >
              Change passphrase
            </button>
          </>
        )}
      </section>

      <section className="space-y-2 border-t border-zinc-900 pt-4">
        <h3 className="text-sm font-semibold">Your data</h3>
        <button className={button} disabled={busy} onClick={() => act(downloadReadable)}>
          <Download className="h-3.5 w-3.5" /> Download my data
        </button>
        {vault.status === 'locked' && (
          <p className="text-xs text-zinc-500">
            Your vault is locked, so notes and the people who went would be unreadable in the file. Unlock it above for a readable copy, or{' '}
            <a className="underline" href={accountApi.exportUrl} download>
              download the encrypted copy
            </a>
            .
          </p>
        )}
        {me.role === 'member' && (
          <>
            <p className="text-xs text-zinc-500">Deleting removes your events, imports and share links. Type your email ({me.email}) to confirm. Backups keep deleted rows until they expire.</p>
            <input className={field} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Your email" />
            <button
              className={`${button} border-rose-500/40 text-rose-300`}
              disabled={busy || confirm.trim().toLowerCase() !== (me.email ?? '').toLowerCase()}
              onClick={() => act(async () => { await accountApi.remove(confirm.trim()); window.location.reload(); })}
            >
              Delete my account
            </button>
          </>
        )}
      </section>

      <section className="space-y-2 border-t border-zinc-900 pt-4">
        <h3 className="text-sm font-semibold">Session</h3>
        <LogOutLink className={button} />
      </section>
    </Dialog>
  );
};
