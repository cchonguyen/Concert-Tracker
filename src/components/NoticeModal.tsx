import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { meApi } from '../services/lineupApi';
import { Dialog } from './ui/Dialog';

// Shown once to a member on first sign-in (and again if the wording changes,
// see NOTICE_VERSION in src/server/auth/routes.ts). There is no way past it
// but accepting.
export const NoticeModal: React.FC<{ onAccepted: () => void }> = ({ onAccepted }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await meApi.acceptNotice();
      onAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Before you start"
      placement="center"
      dismissible={false}
      layer="top"
      panelClassName="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5"
    >
      <h2 className="text-lg font-bold">Before you start</h2>
      <ul className="space-y-3 text-sm text-zinc-300">
        <li>
          <b>What this is.</b> A personal hobby project run by Charlie, not a business. It is offered as is, with no promise it stays
          up, keeps working or keeps your data.
        </li>
        <li>
          <b>Where your data lives.</b> Your events and their details are stored in Supabase. Database rules (row level security)
          keep each member's rows apart, so you see only yours.
        </li>
        <li>
          <b>Your private vault.</b> Your notes and the names of people you went with are encrypted in your browser (AES-GCM)
          before they are saved. If you lose both your passphrase and your recovery key, they cannot be recovered by anyone.
        </li>
        <li>
          <b>Deleting your account.</b> It removes your data from the live database straight away. Automated backups hold older
          copies until they age out on their normal schedule.
        </li>
      </ul>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button
        onClick={busy ? undefined : accept}
        aria-disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 aria-disabled:opacity-40 disabled:opacity-40"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} I understand and accept
      </button>
    </Dialog>
  );
};
