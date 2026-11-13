import { Dialog } from './ui/Dialog';
import { copy } from '../services/copy';
import { LineupStatus, SOURCE_LABELS } from '../services/lineupApi';
import { useIsOwner } from './MeContext';
import { readerLine } from './ReaderPanel';

// What the app is, where your data lives, and what leaves your browser. Every claim here must match the code.
export function AboutDialog({ status, onClose, onShowTips }: { status: LineupStatus | null; onClose: () => void; onShowTips: () => void }) {
  const owner = useIsOwner();
  return (
    <Dialog title={`About ${copy.appName}`} onClose={onClose} panelClassName="h-full w-full max-w-xl space-y-6 overflow-y-auto border-l border-zinc-900 bg-zinc-950 p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-50">About {copy.appName}</h2>
          <p className="text-xs text-zinc-400">Version {copy.appVersion}</p>
        </div>
        <button onClick={onClose} className="rounded-control px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
          Close
        </button>
      </div>

      <section className="space-y-2 text-sm text-zinc-300">
        <h3 className="font-semibold text-zinc-100">What it is</h3>
        <p>
          {copy.appName} remembers which events you went to and who you saw. You add a show by typing it once. It finds the
          date, the venue and the lineup where it can, and you keep the final say on what is saved.
        </p>
      </section>

      <section className="space-y-2 text-sm text-zinc-300">
        <h3 className="font-semibold text-zinc-100">Where your data lives</h3>
        <p>
          Your events are stored in a database that only you can read. Your private notes are encrypted in your browser before
          they are saved, when you turn on the vault.
        </p>
      </section>

      <section className="space-y-2 text-sm text-zinc-300">
        <h3 className="font-semibold text-zinc-100">What leaves your browser</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>Searches for a show go to the public sources listed under Where lineups come from.</li>
          <li>
            The ticket email check reads your Gmail with read-only access. The browser check runs in your browser and sends only the
            shows it finds, plus a link to each email, with the subject, sender and date of every email it examined. Ticket emails
            are read by code written for each ticket seller. No model reads them.
          </li>
        </ul>
      </section>

      {status && (
        <section className="space-y-2 text-sm text-zinc-300">
          <h3 className="font-semibold text-zinc-100">Where lineups come from</h3>
          <p>
            Sources: {status.sources.map((s) => `${SOURCE_LABELS[s.id]}${s.enabled ? '' : ' (off)'}`).join(' · ')}
          </p>
          <p>Gemini {status.gemini ? `${status.quota?.used ?? 0}/${status.quota?.limit ?? '?'} today` : '(off)'}</p>
          {owner && status.reader && <p className="break-words">Reader: {readerLine(status.reader)}</p>}
        </section>
      )}

      <section className="space-y-2 text-sm text-zinc-300">
        <h3 className="font-semibold text-zinc-100">Tips</h3>
        <button onClick={onShowTips} className="rounded-control border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
          Show tips again
        </button>
      </section>

      <section className="space-y-2 text-sm text-zinc-300">
        <h3 className="font-semibold text-zinc-100">Who runs it</h3>
        <p>
          A personal hobby project run by Charlie, not a business. It is offered as is, with no promise it stays up, keeps working
          or keeps your data.
        </p>
      </section>
    </Dialog>
  );
}
