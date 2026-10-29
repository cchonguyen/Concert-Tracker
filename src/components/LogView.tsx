import { useEffect, useState } from 'react';
import { eventsApi } from '../services/lineupApi';
import { describeEntry, type ActivityEntry } from '../server/events/activityLog';
import type { LoggedEvent } from '../server/events/types';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';
import { Confirm } from './ui/Confirm';
import { useVault } from './VaultContext';

// The Log: shows in Recently deleted (Restore brings one back) and every change you have made.
// Undo writes a field back; a notes or companions change is undone only with the vault unlocked.
export function LogView({ eventId, onShowAll }: { eventId?: string | null; onShowAll?: () => void }) {
  const vault = useVault();
  const locked = vault.status !== 'unlocked';
  const [trash, setTrash] = useState<LoggedEvent[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // What the confirm dialog is asking about: one show's id, or 'all' for the whole trash.
  const [erasing, setErasing] = useState<string | 'all' | null>(null);

  const load = async () => {
    try {
      const [active, deleted, log] = await Promise.all([eventsApi.list(), eventsApi.deleted(), eventsApi.activity()]);
      setTrash(deleted);
      setActivity(log);
      setNames(Object.fromEntries([...active.events, ...deleted].map((e) => [e.id, e.name])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the Log.');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      await eventsApi.restore(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore that show.');
    } finally {
      setBusy(null);
    }
  };

  const erase = async (target: string | 'all') => {
    setErasing(null);
    setBusy(target);
    try {
      if (target === 'all') await eventsApi.emptyTrash();
      else await eventsApi.erase(target);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that show.');
    } finally {
      setBusy(null);
    }
  };

  // Says why a change could not be undone, in words, instead of showing the code the server sent.
  const undoReason = (err: unknown) => {
    const text = err instanceof Error ? err.message : '';
    if (text.includes('value-changed')) return 'Not undone: that field was changed again after this.';
    if (text.includes('vault-locked')) return 'Unlock vault to undo.';
    if (text.includes('not-undoable')) return 'This change cannot be undone: its text was not stored.';
    if (text.includes('person-gone')) return 'Not undone: someone you went with is no longer in your people.';
    if (text.includes('gone')) return 'Not undone: that show is no longer there.';
    return 'Could not undo that change.';
  };

  const undo = async (a: ActivityEntry) => {
    setBusy(a.id);
    try {
      await eventsApi.undo(a.id, locked);
      await load();
    } catch (err) {
      setError(undoReason(err));
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (id: string | null) => (id && names[id]) || 'a show';
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="space-y-8">
      {error && <Notice tone="warning">{error}</Notice>}

      {eventId && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-zinc-800 px-4 py-2.5 text-sm text-zinc-300">
          <span>
            Showing the history of <span className="font-semibold text-zinc-100">{nameOf(eventId)}</span>
          </span>
          {onShowAll && (
            <Button variant="ghost" onClick={onShowAll}>
              Show all
            </Button>
          )}
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-bold text-zinc-100">Recently deleted</h2>
          <p className="text-xs text-zinc-400">Deleted shows stay here for 90 days. Restore brings one back with everything it had.</p>
        </div>
        {trash !== null && trash.length > 0 && (
          <div className="flex justify-end">
            <Button variant="danger" onClick={() => setErasing('all')} disabled={busy !== null}>
              Empty recently deleted
            </Button>
          </div>
        )}
        {trash === null ? null : trash.length === 0 ? (
          <p className="text-sm text-zinc-400">Nothing here. Shows you delete appear here for 90 days.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-card border border-zinc-800">
            {trash.filter((e) => !eventId || e.id === eventId).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-100">{e.name}</p>
                  {e.deletedAt && <p className="text-xs text-zinc-400">Deleted {when(e.deletedAt)}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="ghost" onClick={() => setErasing(e.id)} disabled={busy === e.id}>
                    Delete permanently
                  </Button>
                  <Button onClick={() => void restore(e.id)} disabled={busy === e.id}>
                    Restore
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {erasing !== null && (
        <Confirm
          title={erasing === 'all' ? 'Empty recently deleted' : 'Delete permanently'}
          message={
            erasing === 'all'
              ? `${trash?.length ?? 0} shows will be erased for good. Their history in Changes stays.`
              : `"${nameOf(erasing)}" will be erased for good. This cannot be undone.`
          }
          confirmLabel={erasing === 'all' ? 'Empty recently deleted' : 'Delete permanently'}
          onCancel={() => setErasing(null)}
          onConfirm={() => void erase(erasing)}
        />
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-bold text-zinc-100">Changes</h2>
          <p className="text-xs text-zinc-400">Every save, delete and restore, newest first. Kept for a year. Notes and companions show that they changed, not what they say.</p>
        </div>
        {activity === null ? null : activity.length === 0 ? (
          <p className="text-sm text-zinc-400">No changes yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-card border border-zinc-800">
            {activity.filter((a) => !eventId || a.eventId === eventId).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200">{describeEntry(a, nameOf(a.eventId))}</p>
                  <p className="text-xs text-zinc-400">{when(a.at)}</p>
                </div>
                {a.action !== 'undo' && a.eventId && (
                  <Button
                    variant="ghost"
                    onClick={() => void undo(a)}
                    disabled={busy !== null || (a.sensitive && locked)}
                  >
                    {a.sensitive && locked ? 'Unlock vault to undo' : 'Undo'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
