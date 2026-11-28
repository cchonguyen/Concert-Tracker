import { Dialog } from './ui/Dialog';
import React, { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, RefreshCw, Sheet, X } from 'lucide-react';
import { Confirm } from './ui/Confirm';
import { Equalizer } from './ui/Equalizer';
import { eventsApi, SheetsStatus, sheetsApi } from '../services/lineupApi';
import { readTable } from '../services/listImport';
import { pickSpreadsheet } from '../services/googlePicker';
import { droppedColumns, outsideEdits, sheetRows, sheetTable } from '../services/sheetSync';
import { Notice } from './ui/Notice';

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
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text-muted hover:text-text disabled:opacity-40';
const primary =
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40';

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
            <h2 className="flex items-center gap-2 poster-head text-2xl text-text">
              <Sheet className="h-4 w-4 text-accent" /> Google Sheets
            </h2>
            <p className="text-xs text-text-muted">
              A copy of your log in a Google Sheet, for looking at, sorting or sharing. The app is the source of truth: updating writes
              your log into the sheet, and nothing typed in the sheet comes back into the app. Make changes in the app.
            </p>
          </div>
          <button onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-text-muted hover:text-text" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <Notice tone="error">{error}</Notice>}
        {reconnect && (
          <a href="/api/sheets/connect" className={primary}>
            Sign in with Google again
          </a>
        )}
        {message && <Notice tone="success">{message}</Notice>}

        {!status ? (
          <span role="status" aria-label="Loading Google Sheets status" className="inline-flex items-center text-text-muted">
            <Equalizer />
          </span>
        ) : !status.configured ? (
          <p className="text-sm text-text-muted">
            Google sign-in isn't set up on this server yet, so the app can't reach Google Sheets.
          </p>
        ) : !status.connected ? (
          <div className="space-y-2">
            <a href="/api/sheets/connect" className={primary}>
              Sign in with Google
            </a>
            <p className="text-xs text-text-muted">
              {status.member
                ? 'Google asks to let the app use only the sheets it makes for you or that you choose in Google\'s picker. It cannot see the rest of your Drive. Your notes and who you went with are never written to the sheet.'
                : 'Google asks to let the app see and edit your spreadsheets. It only ever opens the one sheet you link.'}
            </p>
          </div>
        ) : !sheet ? (
          <div className="space-y-4">
            <p className="text-xs text-text-muted">Signed in{status.account ? ` as ${status.account}` : ''}.</p>
            {status.member ? (
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wide text-text-muted">Link a sheet</label>
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
                    {busy === 'pick' && <Equalizer size="sm" />} Choose an existing sheet
                  </button>
                ) : (
                  <p className="text-xs text-text-muted">Choosing an existing sheet is not set up on the server yet. You can make a new one.</p>
                )}
                <p className="text-xs text-text-muted">
                  The first tab of the sheet you choose is written; anything already in it is replaced (you're asked first).
                </p>
              </div>
            ) : (
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wide text-text-muted">Link a sheet</label>
              <div className="flex gap-2">
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  className="min-h-11 min-w-0 flex-1 rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9"
                />
                <button
                  onClick={() => run('link', async () => setStatus({ ...status, sheet: await sheetsApi.link(link) }))}
                  disabled={!link.trim() || Boolean(busy)}
                  className={primary}
                >
                  {busy === 'link' && <Equalizer size="sm" />} Link
                </button>
              </div>
              <p className="text-xs text-text-muted">
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
              {busy === 'create' && <Equalizer size="sm" />} Or make a new sheet
            </button>
            <button onClick={() => run('out', async () => (await sheetsApi.disconnect(), load()))} className="block min-h-11 text-xs text-text-muted hover:text-text sm:min-h-9">
              Sign out of Google Sheets
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1 rounded-card border border-line bg-surface-1 p-3">
              <a href={sheet.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-text hover:text-accent">
                {sheet.title} <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <p className="font-mono text-xs tabular-nums text-text-muted">
                Tab "{sheet.tab}" · {sheet.syncedAt ? `last synced ${when(sheet.syncedAt)}` : 'not synced yet'}
                {status.account ? ` · ${status.account}` : ''}
              </p>
            </div>
            <button onClick={sync} disabled={Boolean(busy)} className={primary}>
              {busy === 'sync' ? <Equalizer size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />} Update the sheet
            </button>
            {confirm && (
              <div className="space-y-2 rounded-card border border-line bg-warn-soft p-3 text-text">
                {confirm.edits > 0 && (
                  <p className="flex items-start gap-1.5 text-sm text-text">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                    {confirm.edits} row{confirm.edits === 1 ? '' : 's'} in "{confirm.tab}" {confirm.edits === 1 ? 'was' : 'were'} changed, added or
                    removed in the sheet. Updating replaces {confirm.edits === 1 ? 'it' : 'them'} with your log; nothing from the sheet is
                    saved to the app.
                  </p>
                )}
                {confirm.dropped.length > 0 && (
                  <p className="flex items-start gap-1.5 text-sm text-text">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
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
            <p className="text-xs text-text-muted">Edits typed into the sheet are not read back. Change events in the app, then update the sheet.</p>
            <div className="flex gap-4 text-xs">
              <button onClick={() => setUnlinking(true)} className="min-h-11 text-text-muted hover:text-text sm:min-h-9">
                Unlink this sheet
              </button>
              <button onClick={() => run('out', async () => (await sheetsApi.disconnect(), load()))} className="min-h-11 text-text-muted hover:text-text sm:min-h-9">
                Sign out of Google Sheets
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
};
