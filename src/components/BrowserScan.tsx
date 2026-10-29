import React, { useState } from 'react';
import { Download, Loader2, ScanSearch } from 'lucide-react';
import { scanGmailInBrowser, scanReportCsv, type GmailScanProgress, type GmailScanResult } from '@livearchive/ticket-scanner';
import { EmailImport, EmailScanStatus, importsApi } from '../services/lineupApi';

// The browser scan: a one-time Google sign-in (gmail.readonly, nothing kept),
// Gmail read in this tab by @livearchive/ticket-scanner, and only the shows it
// found sent to the server. The token is revoked when the scan ends.
// "Full re-scan" ignores the watermark and never moves it.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

declare global {
  interface Window {
    google?: any;
  }
}

function loadGis(): Promise<any> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.appendChild(s);
  });
}

function askToken(clientId: string): Promise<string> {
  return loadGis().then(
    (google) =>
      new Promise<string>((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: (r: any) => (r?.access_token ? resolve(r.access_token) : reject(new Error(r?.error_description ?? 'Gmail was not opened.'))),
          error_callback: (e: any) => reject(new Error(e?.message ?? 'The Google sign-in was closed.')),
        });
        client.requestAccessToken({ prompt: '' });
      }),
  );
}

type Mode = 'incremental' | 'full';

export const BrowserScan: React.FC<{ status: EmailScanStatus; onFound: (imports: EmailImport[]) => void }> = ({ status, onFound }) => {
  const [running, setRunning] = useState<Mode | null>(null);
  const [progress, setProgress] = useState<GmailScanProgress | null>(null);
  const [report, setReport] = useState<{ mode: Mode; result: GmailScanResult; saved?: { added: number; changed: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!status.clientId) return null;

  const run = async (mode: Mode) => {
    setRunning(mode);
    setError(null);
    setReport(null);
    setProgress(null);
    let token = '';
    try {
      token = await askToken(status.clientId!);
      const result = await scanGmailInBrowser({
        token,
        cursors: status.browserCursors,
        ignoreCursors: mode === 'full',
        onProgress: setProgress,
      });
      const saved = await importsApi.proposals({
        proposals: result.proposals,
        messages: result.messages,
        // Only the incremental check moves the watermark.
        updatedCursors: mode === 'incremental' ? result.updatedCursors : undefined,
      });
      onFound(await importsApi.list().catch(() => []));
      setReport({ mode, result, saved });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token) window.google?.accounts?.oauth2?.revoke(token, () => undefined);
      setRunning(null);
    }
  };

  const download = () => {
    if (!report) return;
    const csv = scanReportCsv(report.result.proposals, report.result.messages);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ticket-scan-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const button = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:border-zinc-500 disabled:opacity-40';
  const s = report?.result.summary;

  return (
    <div className="space-y-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-zinc-400">Runs in this tab</p>
        <button className={button} disabled={Boolean(running)} onClick={() => run('incremental')}>
          {running === 'incremental' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
          Check for new tickets
        </button>
        <button className={button} disabled={Boolean(running)} onClick={() => run('full')}>
          {running === 'full' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
          Scan everything again
        </button>
      </div>
      {running && (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400">
            {progress?.phase === 'reading'
              ? `Examining message ${progress.examined} of ${progress.total}… Found ${progress.found} concert${progress.found === 1 ? '' : 's'}`
              : 'Searching Gmail…'}
          </p>
          <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-violet-500 transition-all" style={{ width: `${progress?.total ? (100 * progress.examined) / progress.total : 3}%` }} />
          </div>
        </div>
      )}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {report && s && (
        <div className="space-y-2 text-xs text-zinc-300">
          <p className="font-semibold text-zinc-200">
            {report.mode === 'full' ? 'Scan everything again' : 'Check'}
            {report.saved ? `: ${report.saved.added} new on the review list, ${report.saved.changed} rows updated` : ''}
          </p>
          <button className={button} onClick={download}>
            <Download className="h-3.5 w-3.5" /> Download report (CSV)
          </button>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            <dt className="text-zinc-400">Ticket emails examined</dt>
            <dd>
              {s.examined}
              {s.failed ? ` (+${s.failed} Gmail would not open${report.result.failureReason ? `: ${report.result.failureReason}` : ''})` : ''}
            </dd>
            <dt className="text-zinc-400">Concerts found</dt>
            <dd>{s.proposals}</dd>
            <dt className="text-zinc-400">Different shows</dt>
            <dd>{s.netUniqueEvents}</dd>
            <dt className="text-zinc-400">Flagged (refund, cancel, transfer)</dt>
            <dd>{s.flagged}</dd>
            <dt className="text-zinc-400">Unreadable</dt>
            <dd>{s.unreadable.length}</dd>
            <dt className="text-zinc-400">Skipped (no receipt wording)</dt>
            <dd>{s.skipped}</dd>
          </dl>
          {Object.keys(s.bySeller).length > 0 && (
            <div>
              <p className="text-zinc-400">By seller</p>
              <ul className="flex flex-wrap gap-x-3">
                {Object.entries(s.bySeller)
                  .sort((a, b) => b[1] - a[1])
                  .map(([seller, n]) => (
                    <li key={seller}>
                      {seller} <span className="text-zinc-400">{n}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {s.unreadable.length > 0 && (
            <details>
              <summary className="cursor-pointer text-zinc-400">Unreadable emails</summary>
              <ul className="mt-1 space-y-0.5">
                {s.unreadable.map((u, i) => (
                  <li key={i}>
                    <a href={u.links[0]} target="_blank" rel="noreferrer" className="hover:text-violet-300">
                      {u.subject}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
};
