import React, { useState } from 'react';
import { Equalizer } from './ui/Equalizer';
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
      panelClassName="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-card border border-line bg-page p-5"
    >
      <h2 className="font-display text-xl font-normal">Before you start</h2>
      <ul className="space-y-3 text-sm text-text-muted">
        <li>
          <b>What this is.</b> A personal hobby project run by Charlie, not a business. It is offered as is, with no promise it stays
          up, keeps working or keeps your data.
        </li>
        <li>
          <b>Where your data lives.</b> Your events and their details are stored in Supabase. Database rules (row level security)
          keep each member's rows apart, so you see only yours.
        </li>
        <li>
          <b>What is shared.</b> When you save an event with a full date, the event's name, date, venue, city and state may be added to a
          shared list of editions, so the next person who adds the same show gets the details filled in. It is marked provisional
          until it is checked. The names of acts you tick as seen may appear, without your name, in the site owner's list of
          artists, so genres can be set for them. Genres are shared: everyone sees the same ones. Your notes, companions, rating,
          price and attendance are never shared.
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
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <button
        onClick={busy ? undefined : accept}
        aria-disabled={busy}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-fill aria-disabled:opacity-40 disabled:opacity-40 sm:min-h-9"
      >
        {busy && <Equalizer size="sm" />} I understand and accept
      </button>
    </Dialog>
  );
};
