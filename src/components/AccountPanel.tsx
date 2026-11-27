import { Dialog } from './ui/Dialog';
import React, { useEffect, useState } from 'react';
import { Download, Lock, Mail, Unlock, X } from 'lucide-react';
import { IconButton } from './ui/IconButton';
import { accountApi, emailPrefsApi, type EmailPrefsView } from '../services/lineupApi';
import { hasCiphertext, type ExportBundle } from '../services/exportBundle';
import { useMe } from './MeContext';
import { useVault } from './VaultContext';
import { LogOutLink } from './LogOutLink';
import { Confirm } from './ui/Confirm';

// Multi-user only: the private-notes vault and "Download / delete my data".
// The recovery key is shown once and the server never sees it.

const button = 'inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40 sm:min-h-9';
const field = 'min-h-11 w-full rounded-control border border-line-strong bg-surface-1 px-3 py-2 text-sm text-text sm:min-h-9';

export const AccountPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const me = useMe();
  const vault = useVault();
  const [passphrase, setPassphrase] = useState('');
  const [next, setNext] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [emailPrefs, setEmailPrefs] = useState<EmailPrefsView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!me.multiUser || !me.email) return;
    emailPrefsApi.get().then(setEmailPrefs, () => {});
  }, [me.multiUser, me.email]);

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
    <Dialog title="Your account" onClose={onClose} panelClassName="h-full w-full max-w-md space-y-5 overflow-y-auto border-l border-line bg-page p-5">
      <div className="flex items-center justify-between">
        <h2 className="poster-head text-2xl">Your account</h2>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {done && <p className="text-xs text-good">{done}</p>}

      <section className="space-y-2">
        <h3 className="font-display text-base font-normal">Private notes</h3>
        {vault.status === 'unavailable' || vault.status === 'loading' ? (
          <p className="text-xs text-text-muted">Not available.</p>
        ) : vault.status === 'off' && !recoveryKey ? (
          <>
            <p className="text-xs text-text-muted">
              Encrypts your notes in this browser, so the server (and the owner) only ever stores unreadable text. Lose both the passphrase and the recovery key and the notes are gone.
            </p>
            <input aria-label="Passphrase (8+ characters)" type="password" className={field} placeholder="Passphrase (8+ characters)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
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
            <p className="text-xs text-warn">Save this recovery key somewhere safe. It is shown once and is the only way back in if you forget the passphrase.</p>
            <code className="block select-all break-all rounded-control bg-surface-1 p-3 text-xs">{recoveryKey}</code>
            <button className={button} onClick={() => setRecoveryKey(null)}>
              I have saved it
            </button>
          </>
        ) : vault.status === 'locked' ? (
          <>
            <input
              type="password"
              className={field}
              aria-label={useRecovery ? 'Recovery key' : 'Passphrase'}
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
            <p className="text-xs text-good">Unlocked in this tab. Reloading locks it again.</p>
            <button className={button} onClick={() => vault.lock()}>
              <Lock className="h-3.5 w-3.5" /> Lock now
            </button>
            <input aria-label="Current passphrase" type="password" className={field} placeholder="Current passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <input aria-label="New passphrase" type="password" className={field} placeholder="New passphrase" value={next} onChange={(e) => setNext(e.target.value)} />
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

      <section className="space-y-2 border-t border-line pt-4">
        <h3 className="font-display text-base font-normal">Email notifications</h3>
        <p className="text-xs text-text-muted">
          {me.role === 'owner'
            ? 'Receive at most one daily digest email when new access requests arrive.'
            : 'Receive account invite and approval confirmation emails. Every email also has a one-click unsubscribe link.'}
        </p>
        {emailPrefs ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-muted">
              {emailPrefs.optedOut ? 'Opted out of all emails' : 'Subscribed to account emails'}
            </span>
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                act(
                  async () => {
                    const updated = await emailPrefsApi.setOptOut(!emailPrefs.optedOut);
                    setEmailPrefs(updated);
                  },
                  emailPrefs.optedOut ? 'Subscribed to emails again.' : 'Opted out of LiveArchive emails.',
                )
              }
            >
              <Mail className="h-3.5 w-3.5" /> {emailPrefs.optedOut ? 'Receive emails' : 'Opt out of emails'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-text-muted">Loading email settings…</p>
        )}
      </section>

      <section className="space-y-2 border-t border-line pt-4">
        <h3 className="font-display text-base font-normal">Your data</h3>
        <button className={button} disabled={busy} onClick={() => act(downloadReadable)}>
          <Download className="h-3.5 w-3.5" /> Download my data
        </button>
        {vault.status === 'locked' && (
          <p className="text-xs text-text-muted">
            Your vault is locked, so notes and the people who went would be unreadable in the file. Unlock it above for a readable copy, or{' '}
            <a className="underline" href={accountApi.exportUrl} download>
              download the encrypted copy
            </a>
            .
          </p>
        )}
        {me.role === 'member' && (
          <>
            <p className="text-xs text-text-muted">Deleting removes your events, imports and share links. Backups keep deleted rows until they expire.</p>
            <button className={`${button} border-bad/45 text-bad`} disabled={busy} onClick={() => setDeleting(true)}>
              Delete my account
            </button>
            {deleting && (
              <Confirm
                title="Delete my account"
                message="Your events, imports and share links are deleted. Backups keep deleted rows until they expire. This cannot be undone."
                confirmLabel="Delete my account"
                typedMatch={me.email ?? ''}
                onCancel={() => setDeleting(false)}
                onConfirm={() => {
                  setDeleting(false);
                  void act(async () => {
                    await accountApi.remove(me.email ?? '');
                    window.location.reload();
                  });
                }}
              />
            )}
          </>
        )}
      </section>

      <section className="space-y-2 border-t border-line pt-4">
        <h3 className="font-display text-base font-normal">Session</h3>
        <LogOutLink className={button} />
      </section>
    </Dialog>
  );
};
