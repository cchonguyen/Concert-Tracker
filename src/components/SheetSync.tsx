import { Dialog } from './ui/Dialog';
import React, { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, Sheet, X } from 'lucide-react';
import { Confirm } from './ui/Confirm';
import { eventsApi, SheetsStatus, sheetsApi } from '../services/lineupApi';
import { readTable } from '../services/listImport';
import { pickSpreadsheet } from '../services/googlePicker';
import { droppedColumns, outsideEdits, sheetRows, sheetTable } from '../services/sheetSync';

// "Google Sheets" in the Table view: sign in, link a sheet, and update it.
// One way: the app is the source of truth and writes your log into the tab;
// nothing in the sheet is read back into the app. Before edits made in the
// sheet are replaced, you're told how many. See ARCHITECTURE.md ("Google
// Sheets sync").

interface SheetSyncProps {
  notice?: string | null; // back from Google's sign-in
  onClose: () => void;
}

const button =
  'inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';
const primary =
  'inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40';

// The sign-in lacks Sheets access (or Google asks to connect again): offer a fresh sign-in.
const RECONNECT = /sign in to google sheets again/i;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const SheetSync: React.FC<SheetSyncProps> = ({ notice, onClose }) => {
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(notice && notice !== 'connected' ? notice : null);
  const [reconnect, setReconnect] = useState<boolean>(RECONNECT.test(notice ?? ''));
  const [message, setMessage] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  // Edits made in the sheet that updating would replace, waiting for your OK.
  const [confirm, setConfirm] = useState<{ version: string; edits: number; dropped: string[]; tab: string } | null>(null);

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
    setReconnect(false);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setReconnect(RECONNECT.test(msg) || (err as { status?: number })?.status === 409);
      void load();
    } finally {
      setBusy(null);
    }
  };

  // The tab rewritten from your log as it is now, if it still is what was read.
  const write = async (version: string) => {
    const fresh = await eventsApi.list();
    const sheet = await sheetsApi.write(sheetRows(fresh.events, fresh.editions ?? {}, { omitPrivate: Boolean(status?.member) }), version);
    setStatus((s) => (s ? { ...s, sheet } : s));
    setMessage(`The sheet now lists your ${fresh.events.length} event${fresh.events.length === 1 ? '' : 's'}.`);
  };

  const sync = () =>
    run('sync', async () => {
      setConfirm(null);
      const { values, version, base: written, sheet } = await sheetsApi.read();
      const table = sheetTable(values);
      const list = readTable(table);
      if (list.error && list.rows.length === 0 && table.filter((r) => r.some((c) => c.trim())).length > 1) {
        // Cells that aren't an events list: never overwrite them.
        throw new Error(`The "${sheet.tab}" tab has data but no Event or Name column, so it was left alone. Link an empty tab or a new sheet.`);
      }
      const edits = outsideEdits(table, written ? sheetTable(written) : undefined);
      const dropped = list.error ? [] : droppedColumns(list);
      if (!edits && !dropped.length) return write(version);
      setConfirm({ version, edits, dropped, tab: sheet.tab });
    });

  const sheet = status?.sheet;
  return (
    <Dialog title="Google Sheets" onClose={onClose}>
      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Sheet className="h-4 w-4 text-violet-400" /> Google Sheets
            </h2>
            <p className="text-xs text-zinc-400">
              A copy of your log in a Google Sheet, for looking at, sorting or sharing. The app is the source of truth: updating writes
              your log into the sheet, and nothing typed in the sheet comes back into the app. Make changes in the app.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}
        {reconnect && (
          <a href="/api/sheets/connect" className={primary}>
            Sign in with Google again
          </a>
        )}
        {message && <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2 text-sm text-emerald-200">{message}</p>}

        {!status ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : !status.configured ? (
          <p className="text-sm text-zinc-400">
            Google sign-in isn't set up on this server yet, so the app can't reach Google Sheets.
          </p>
        ) : !status.connected ? (
          <div className="space-y-2">
            <a href="/api/sheets/connect" className={primary}>
              Sign in with Google
            </a>
            <p className="text-xs text-zinc-400">
              {status.member
                ? 'Google asks to let the app use only the sheets it makes for you or that you choose in Google\'s picker. It cannot see the rest of your Drive. Your notes and who you went with are never written to the sheet.'
                : 'Google asks to let the app see and edit your spreadsheets. It only ever opens the one sheet you link.'}
            </p>
          </div>
        ) : !sheet ? (
          <div className="space-y-4">
            <p className="text-xs text-zinc-400">Signed in{status.account ? ` as ${status.account}` : ''}.</p>
            {status.member ? (
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wide text-zinc-400">Link a sheet</label>
                {status.picker ? (
                  <button
                    onClick={() =>
                      run('pick', async () => {
                        const id = await pickSpreadsheet(await sheetsApi.pickerInfo());
                        if (id) setStatus({ ...status, sheet: await sheetsApi.linkPicked(id) });
                      })
                    }
                    disabled={Boolean(busy)}
                    className={primary}
                  >
                    {busy === 'pick' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Choose an existing sheet
                  </button>
                ) : (
                  <p className="text-xs text-zinc-400">Choosing an existing sheet is not set up on the server yet. You can make a new one.</p>
                )}
                <p className="text-xs text-zinc-400">
                  The first tab of the sheet you choose is written; anything already in it is replaced (you're asked first).
                </p>
              </div>
            ) : (
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wide text-zinc-400">Link a sheet</label>
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
              <p className="text-xs text-zinc-400">
                The tab open in the link is the one written. Use an empty tab: anything already in it is replaced (you're asked first).
                To bring events from a sheet into the app, download it as CSV and use Import a list.
              </p>
            </div>
            )}
            <button
              onClick={() => run('create', async () => setStatus({ ...status, sheet: await sheetsApi.create() }))}
              disabled={Boolean(busy)}
              className={button}
            >
              {busy === 'create' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Or make a new sheet
            </button>
            <button onClick={() => run('out', async () => (await sheetsApi.disconnect(), load()))} className="block text-xs text-zinc-400 hover:text-zinc-300">
              Sign out of Google Sheets
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
              <a href={sheet.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-100 hover:text-violet-300">
                {sheet.title} <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <p className="text-xs text-zinc-400">
                Tab "{sheet.tab}" · {sheet.syncedAt ? `last synced ${when(sheet.syncedAt)}` : 'not synced yet'}
                {status.account ? ` · ${status.account}` : ''}
              </p>
            </div>
            <button onClick={sync} disabled={Boolean(busy)} className={primary}>
              {busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Update the sheet
            </button>
            {confirm && (
              <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3">
                {confirm.edits > 0 && (
                  <p className="flex items-start gap-1.5 text-sm text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {confirm.edits} row{confirm.edits === 1 ? '' : 's'} in "{confirm.tab}" {confirm.edits === 1 ? 'was' : 'were'} changed, added or
                    removed in the sheet. Updating replaces {confirm.edits === 1 ? 'it' : 'them'} with your log; nothing from the sheet is
                    saved to the app.
                  </p>
                )}
                {confirm.dropped.length > 0 && (
                  <p className="flex items-start gap-1.5 text-sm text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    The {confirm.dropped.map((d) => `"${d}"`).join(', ')} column{confirm.dropped.length === 1 ? ' is' : 's are'} not part of
                    the app and will be removed.
                  </p>
                )}
                <div className="flex gap-2">
                  <button onClick={() => run('sync', async () => (setConfirm(null), write(confirm.version)))} disabled={Boolean(busy)} className={primary}>
                    Replace the sheet
                  </button>
                  <button onClick={() => setConfirm(null)} className={button}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {unlinking && (
              <Confirm
                title="Unlink this sheet"
                message="Your sheet stays in Drive. LiveArchive stops syncing it."
                confirmLabel="Unlink sheet"
                onCancel={() => setUnlinking(false)}
                onConfirm={() => {
                  setUnlinking(false);
                  void run('unlink', async () => (await sheetsApi.unlink(), load()));
                }}
              />
            )}
            <p className="text-xs text-zinc-400">Edits typed into the sheet are not read back. Change events in the app, then update the sheet.</p>
            <div className="flex gap-4 text-xs">
              <button onClick={() => setUnlinking(true)} className="text-zinc-400 hover:text-zinc-300">
                Unlink this sheet
              </button>
              <button onClick={() => run('out', async () => (await sheetsApi.disconnect(), load()))} className="text-zinc-400 hover:text-zinc-300">
                Sign out of Google Sheets
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
};
