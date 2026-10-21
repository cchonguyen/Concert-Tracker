import React, { useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Sheet, X } from 'lucide-react';
import { EmailImport, eventsApi, LoggedEvent, SheetsStatus, sheetsApi } from '../services/lineupApi';
import { ImportResult, readTable } from '../services/listImport';
import { droppedColumns, rowsToReview, sheetRows, sheetTable } from '../services/sheetSync';
import { ListImport } from './ListImport';

// "Google Sheets" in the Table view: sign in, link a sheet, and sync. A sync
// reads the linked tab first; what it changed, and rows it added, are
// reviewed in the list import before anything is saved. Then the tab is
// rewritten from your log. See ARCHITECTURE.md ("Google Sheets sync").

interface SheetSyncProps {
  events: LoggedEvent[];
  imports: EmailImport[];
  notice?: string | null; // back from Google's sign-in
  onDone: () => void;
  onClose: () => void;
}

const button =
  'inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';
const primary =
  'inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const SheetSync: React.FC<SheetSyncProps> = ({ events, imports, notice, onDone, onClose }) => {
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(notice && notice !== 'connected' ? notice : null);
  const [message, setMessage] = useState<string | null>(null);
  const [review, setReview] = useState<{ title: string; table: string[][]; version: string; dropped: string[] } | null>(null);

  const load = () =>
    sheetsApi
      .status()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    void load();
  }, []);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      setBusy(null);
    }
  };

  // The tab rewritten from your log as it is now, if it still is what was read.
  const write = async (version: string) => {
    const fresh = await eventsApi.list();
    const sheet = await sheetsApi.write(sheetRows(fresh.events, fresh.editions ?? {}), version);
    setStatus((s) => (s ? { ...s, sheet } : s));
    setMessage(`The sheet now lists your ${fresh.events.length} event${fresh.events.length === 1 ? '' : 's'}.`);
  };

  const sync = () =>
    run('sync', async () => {
      const { values, version, sheet } = await sheetsApi.read();
      const table = sheetTable(values);
      const list = readTable(table);
      if (list.error && list.rows.length === 0 && table.filter((r) => r.some((c) => c.trim())).length > 1) {
        // Cells the import can't place: never overwrite them.
        throw new Error(`The "${sheet.tab}" tab has data but no Event or Name column, so it was left alone. Link an empty tab or a new sheet.`);
      }
      if (list.error || rowsToReview(list, events, imports) === 0) return write(version);
      setReview({ title: sheet.title, table, version, dropped: droppedColumns(list) });
    });

  const saved = (result: ImportResult) => {
    const r = review;
    setReview(null);
    if (!r) return;
    if (result.failed.length) {
      setError(
        `${result.failed.map((f) => `${f.row.name}: ${f.error}`).join(' ')} The sheet was left as it is so nothing in it is lost; sync again after fixing these.`,
      );
      return;
    }
    void run('sync', () => write(r.version));
  };

  if (review) {
    return (
      <ListImport
        events={events}
        imports={imports}
        sheet={{ title: review.title, table: review.table, dropped: review.dropped }}
        onDone={onDone}
        onSaved={saved}
        onClose={() => setReview(null)}
      />
    );
  }

  const sheet = status?.sheet;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col border-l border-zinc-900 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Sheet className="h-4 w-4 text-violet-400" /> Google Sheets
              </h2>
              <p className="text-xs text-zinc-500">
                Keep a Google Sheet in step with your log. Edit there or here; each sync shows what the sheet changed before saving it,
                then rewrites the sheet from the app.
              </p>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}
          {message && <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2 text-sm text-emerald-200">{message}</p>}

          {!status ? (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
          ) : !status.configured ? (
            <p className="text-sm text-zinc-400">
              Google sign-in isn't set up on the server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, the same as Check email).
            </p>
          ) : !status.connected ? (
            <div className="space-y-2">
              <a href="/api/sheets/connect" className={primary}>
                Sign in with Google
              </a>
              <p className="text-xs text-zinc-600">
                Google asks to let the app see and edit your spreadsheets. It only ever opens the one sheet you link.
              </p>
            </div>
          ) : !sheet ? (
            <div className="space-y-4">
              <p className="text-xs text-zinc-500">Signed in{status.account ? ` as ${status.account}` : ''}.</p>
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wide text-zinc-500">Link a sheet</label>
                <div className="flex gap-2">
                  <input
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/..."
                    className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
                  />
                  <button
                    onClick={() => run('link', async () => setStatus({ ...status, sheet: await sheetsApi.link(link) }))}
                    disabled={!link.trim() || Boolean(busy)}
                    className={primary}
                  >
                    {busy === 'link' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Link
                  </button>
                </div>
                <p className="text-xs text-zinc-600">
                  The tab open in the link is the one synced. Rows already in it are offered as events on the first sync; columns the app
                  doesn't use are removed when it rewrites the tab.
                </p>
              </div>
              <button
                onClick={() => run('create', async () => setStatus({ ...status, sheet: await sheetsApi.create() }))}
                disabled={Boolean(busy)}
                className={button}
              >
                {busy === 'create' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Or make a new sheet
              </button>
              <button onClick={() => run('out', async () => (await sheetsApi.disconnect(), load()))} className="block text-xs text-zinc-500 hover:text-zinc-300">
                Sign out of Google Sheets
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
                <a href={sheet.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-100 hover:text-violet-300">
                  {sheet.title} <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <p className="text-xs text-zinc-500">
                  Tab "{sheet.tab}" · {sheet.syncedAt ? `last synced ${when(sheet.syncedAt)}` : 'not synced yet'}
                  {status.account ? ` · ${status.account}` : ''}
                </p>
              </div>
              <button onClick={sync} disabled={Boolean(busy)} className={primary}>
                {busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync now
              </button>
              <ul className="list-disc space-y-1 pl-4 text-xs text-zinc-500">
                <li>Edit any column except Type, Artist, Supporting artists, Favourite set and Weather: those are worked out by the app. Edit acts in "Saw".</li>
                <li>Add a row (leave ID empty) to add an event; it's matched against your log like an imported list.</li>
                <li>Deleting a row doesn't delete the event. It comes back on the next sync; delete events in the app.</li>
                <li>Keep the ID column: it's how a row finds its event.</li>
              </ul>
              <div className="flex gap-4 text-xs">
                <button onClick={() => run('unlink', async () => (await sheetsApi.unlink(), load()))} className="text-zinc-500 hover:text-zinc-300">
                  Unlink this sheet
                </button>
                <button onClick={() => run('out', async () => (await sheetsApi.disconnect(), load()))} className="text-zinc-500 hover:text-zinc-300">
                  Sign out of Google Sheets
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
