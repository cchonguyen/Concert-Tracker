import { useEffect, useState } from 'react';
import { eventsApi } from '../services/lineupApi';
import { describeEntry, type ActivityEntry } from '../server/events/activityLog';
import type { LoggedEvent } from '../server/events/types';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';

// The Log: shows in Recently deleted (Restore brings one back) and every change you have made.
// Undo is not on this page yet; it needs the field-level write from the store wrapper.
export function LogView() {
  const [trash, setTrash] = useState<LoggedEvent[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const nameOf = (id: string | null) => (id && names[id]) || 'a show';
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="space-y-8">
      {error && <Notice tone="warning">{error}</Notice>}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-bold text-zinc-100">Recently deleted</h2>
          <p className="text-xs text-zinc-500">Deleted shows stay here for 90 days. Restore brings one back with everything it had.</p>
        </div>
        {trash === null ? null : trash.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing here. Shows you delete appear here for 90 days.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-card border border-zinc-800">
            {trash.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-100">{e.name}</p>
                  {e.deletedAt && <p className="text-xs text-zinc-500">Deleted {when(e.deletedAt)}</p>}
                </div>
                <Button onClick={() => void restore(e.id)} disabled={busy === e.id}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-bold text-zinc-100">Changes</h2>
          <p className="text-xs text-zinc-500">Every save, delete and restore, newest first. Kept for a year. Notes and companions show that they changed, not what they say.</p>
        </div>
        {activity === null ? null : activity.length === 0 ? (
          <p className="text-sm text-zinc-500">No changes yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-card border border-zinc-800">
            {activity.map((a) => (
              <li key={a.id} className="px-4 py-2.5">
                <p className="text-sm text-zinc-200">{describeEntry(a, nameOf(a.eventId))}</p>
                <p className="text-xs text-zinc-500">{when(a.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
