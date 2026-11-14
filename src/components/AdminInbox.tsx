import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { canonicalApi, inboxApi, type InboxItem, type InboxTrace } from '../services/lineupApi';
import { change, editionLine, failedReason, groupByKind, mergeChoices, traceSummary } from '../services/adminInbox';
import { editionUrl, isModifiedClick, rememberManageSearch } from '../services/manageNav';
import { useIsOwner, useMe } from './MeContext';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';

interface Result { text: string; undo?: { changeId: string; editionId: string } }
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

// Owner inbox for the Global archive: open review items by kind, then recent activity. Hidden for members and in sample mode.
export const AdminInbox: React.FC = () => {
  const owner = useIsOwner();
  const sample = useMe().sample;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [traces, setTraces] = useState<InboxTrace[]>([]);
  const [tableMissing, setTableMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await inboxApi.review());
    } catch (e) {
      setError(msg(e));
    }
    try {
      const t = await inboxApi.traces(20);
      setTraces(t.traces);
      setTableMissing(t.tableMissing);
    } catch {
      setTraces([]);
    }
  }, []);
  useEffect(() => {
    if (owner && !sample) void load();
  }, [owner, sample, load]);

  if (!owner || sample) return null;

  const run = async (item: InboxItem, label: string, fn: () => Promise<{ changeId?: string | null } | unknown>) => {
    setBusy(item.id);
    try {
      const r = (await fn()) as { changeId?: string | null };
      setResults((p) => ({ ...p, [item.id]: { text: label, undo: r?.changeId && item.editionId ? { changeId: r.changeId, editionId: item.editionId } : undefined } }));
      setItems((p) => (p ?? []).filter((i) => i.id !== item.id));
    } catch (e) {
      setResults((p) => ({ ...p, [item.id]: { text: `Could not do that. ${msg(e)}` } }));
    } finally {
      setBusy(null);
    }
  };
  const undo = async (key: string, u: { changeId: string; editionId: string }) => {
    setBusy(key);
    try {
      await inboxApi.undo(u.changeId, u.editionId);
      setResults((p) => ({ ...p, [key]: { text: 'Undone. The item is closed; the edition is back as it was.' } }));
    } catch (e) {
      setResults((p) => ({ ...p, [key]: { text: `Could not undo. ${msg(e)}` } }));
    } finally {
      setBusy(null);
    }
  };

  const groups = groupByKind(items ?? []);
  const done = Object.entries(results).filter(([id]) => !(items ?? []).some((i) => i.id === id));

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3" aria-label="Owner inbox">
      <h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 text-base font-semibold text-zinc-100 hover:text-white"
        >
          {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
          <span>Inbox</span>
          {Boolean(items && items.length > 0) && <Pill tone="accent">{items!.length}</Pill>}
        </button>
      </h2>
      {open && (
        <>
          {error && <p className="text-sm text-amber-300">Could not load the inbox. {error} <button className="underline" onClick={() => void load()}>Try again</button></p>}
          {items && !error && groups.length === 0 && <p className="text-sm text-zinc-400">Nothing waiting for you.</p>}
          {groups.map((g) => (
            <div key={g.kind} className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-200">{g.label} <Pill tone="accent">{g.items.length}</Pill></h3>
              <ul className="space-y-2">
                {g.items.map((it) => (
                  <InboxRow key={it.id} item={it} busy={busy === it.id} onRun={run} />
                ))}
              </ul>
            </div>
          ))}
          {done.length > 0 && (
            <ul className="space-y-1">
              {done.map(([id, r]) => (
                <li key={id} className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
                  <span className="min-w-0 flex-1">{r.text}</span>
                  {r.undo && (
                    <button onClick={() => void undo(id, r.undo!)} disabled={busy === id} className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200 disabled:opacity-40">
                      <Undo2 className="h-3.5 w-3.5" /> Undo
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-zinc-200">Recent activity</h3>
            {tableMissing ? (
              <p className="text-sm text-zinc-400">Activity appears once the traces table is set up.</p>
            ) : traces.length === 0 ? (
              <p className="text-sm text-zinc-400">No activity yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {traces.map((t) => {
                  const s = traceSummary(t);
                  return (
                    <li key={t.id} className="rounded-lg border border-zinc-800 p-2 text-xs text-zinc-400">
                      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
                        <span>{s.title}</span>
                        <span className="text-xs text-zinc-400">{new Date(t.createdAt).toLocaleString()}</span>
                      </div>
                      <div>For {s.target}. {s.steps}. {s.requests}.</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
};

const InboxRow: React.FC<{
  item: InboxItem;
  busy: boolean;
  onRun: (item: InboxItem, label: string, fn: () => Promise<unknown>) => void;
}> = ({ item, busy, onRun }) => {
  const c = change(item);
  const dismiss = (label: string, text: string) => <Button variant="ghost" disabled={busy} onClick={() => onRun(item, text, () => inboxApi.dismiss(item.id))}>{label}</Button>;
  const editionId = item.editionId || item.edition?.id;
  const line = editionLine(item.edition);
  return (
    <li className="space-y-2 rounded-lg border border-zinc-800 p-2.5">
      <p className="break-words text-sm text-zinc-100">
        {editionId ? (
          <a
            href={editionUrl(editionId)}
            onClick={(e) => {
              if (isModifiedClick(e)) return;
              e.preventDefault();
              const url = editionUrl(editionId);
              window.history.pushState({ fromManageList: false }, '', url);
              rememberManageSearch(new URL(url, window.location.origin).search);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
            className="hover:text-violet-300 hover:underline"
          >
            {line}
          </a>
        ) : (
          line
        )}
      </p>
      {c && <p className="break-words text-sm text-zinc-300">{c.field}: {c.oldValue} became {c.newValue}.</p>}
      {item.kind === 'failed_lookup' && <p className="text-sm text-zinc-300">{failedReason(item)}</p>}
      <div className="flex flex-wrap gap-2">
        {item.kind === 'override' && (
          <>
            <Button variant="primary" disabled={busy} onClick={() => onRun(item, 'Used for everyone.', () => inboxApi.promote(item.id))}>Use this value for everyone</Button>
            {dismiss('Keep as is', 'Kept as is.')}
          </>
        )}
        {item.kind === 'provisional' && (
          <>
            <Button variant="primary" disabled={busy} onClick={() => onRun(item, 'Marked verified.', () => inboxApi.verify(item.id))}>Mark verified</Button>
            {dismiss('Dismiss', 'Dismissed.')}
          </>
        )}
        {item.kind === 'merge_suggestion' && <MergePicker item={item} busy={busy} onRun={onRun} />}
        {item.kind === 'merge_suggestion' && dismiss('Dismiss', 'Dismissed.')}
        {item.kind === 'formatting' && dismiss('Got it', 'Noted.')}
        {item.kind === 'failed_lookup' && dismiss('Dismiss', 'Dismissed.')}
      </div>
    </li>
  );
};

// Pick which edition to keep; the other is merged into it. Merging cannot be undone here.
const MergePicker: React.FC<{ item: InboxItem; busy: boolean; onRun: (item: InboxItem, label: string, fn: () => Promise<unknown>) => void }> = ({ item, busy, onRun }) => {
  const ids = mergeChoices(item);
  const [names, setNames] = useState<Record<string, string>>({});
  const [keep, setKeep] = useState(ids[0] ?? '');
  useEffect(() => {
    ids.forEach((id) => {
      canonicalApi.edition(id).then((r) => setNames((p) => ({ ...p, [id]: editionLine(r.edition as any) })), () => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
  const drop = ids.find((i) => i !== keep);
  if (ids.length < 2) return null;
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-zinc-300">
        Keep
        <select value={keep} onChange={(e) => setKeep(e.target.value)} className="min-w-0 flex-1 rounded-control border border-zinc-700 bg-zinc-900 p-1.5 text-sm text-zinc-100">
          {ids.map((id) => <option key={id} value={id}>{names[id] ?? id}</option>)}
        </select>
      </label>
      <Button variant="primary" disabled={busy || !drop} onClick={() => drop && onRun(item, 'Merged. This cannot be undone here.', () => inboxApi.merge(item.id, keep, drop))}>Merge</Button>
    </div>
  );
};
