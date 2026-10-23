import React, { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, GitMerge, Loader2, Mail, RefreshCw, Undo2, X } from 'lucide-react';
import { EmailImport, EmailScanStatus, importsApi, LoggedEvent } from '../services/lineupApi';
import type { MergeField } from '../server/events/email/types';
import { placeLabel, whenLabel } from '../services/format';

// Stage 1 from email: shows found in your ticket emails. A ticket is not
// proof you went, so nothing starts ticked and nothing is saved until you
// press Add. See ARCHITECTURE.md ("Stage 1 from email").

interface ImportReviewProps {
  imports: EmailImport[];
  onChange: (imports: EmailImport[]) => void;
  onAdded: (events: LoggedEvent[]) => void;
  events: LoggedEvent[]; // your log, to merge an email's show into one you entered
  onEventChanged: (event: LoggedEvent) => void;
  onClose: () => void;
  notice?: string | null; // the result of Connect Gmail, when you just came back from it
}

const FLAG_LABELS: Record<EmailImport['flags'][number], string> = {
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  transferred_away: 'Tickets sent to someone else',
};

const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-500';

const EmailLink: React.FC<{ row: EmailImport }> = ({ row }) => {
  const link = row.sources.name?.link ?? row.messages.find((m) => m.link)?.link;
  return link ? (
    <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-violet-300">
      {row.seller} email <ExternalLink className="h-2.5 w-2.5" />
    </a>
  ) : (
    <span>{row.seller} email</span>
  );
};

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Check email: reads the ticket mail that arrived since the last check, a few
// messages per call, until nothing is left. New shows land below, unticked.
const CheckEmail: React.FC<{ onFound: (imports: EmailImport[]) => void }> = ({ onFound }) => {
  const [status, setStatus] = useState<EmailScanStatus | null>(null);
  const [progress, setProgress] = useState<{ read: number; added: number; skipped: number; remaining?: number; waiting?: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    importsApi.scanStatus().then(setStatus).catch(() => undefined);
  }, []);

  if (!status?.configured) return null;

  const check = async () => {
    setChecking(true);
    setError(null);
    let read = 0;
    let added = 0;
    let skipped = 0;
    let waits = 0;
    try {
      for (;;) {
        let step;
        try {
          step = await importsApi.scan();
        } catch (err) {
          // Gmail asked to slow down: wait, then carry on where it stopped.
          if (!(err as { retry?: boolean }).retry || waits >= 5) throw err;
          waits++;
          setProgress((p) => ({ read, added, skipped, remaining: p?.remaining, waiting: true }));
          await new Promise((resolve) => setTimeout(resolve, 15000));
          continue;
        }
        read += step.read;
        added += step.added;
        skipped += step.skipped ?? 0;
        setProgress({ read, added, skipped, remaining: step.remaining });
        setStatus((s) => s && { ...s, scannedThrough: step.scannedThrough, lastCheckedAt: step.lastCheckedAt ?? s.lastCheckedAt });
        if (!step.remaining || !(step.read || step.skipped)) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof Error && /connect gmail/i.test(err.message)) setStatus((s) => s && { ...s, connected: false });
    } finally {
      setChecking(false);
      if (read) onFound(await importsApi.list().catch(() => []));
    }
  };

  const summary = () => {
    if (checking) {
      if (!progress) return 'Looking for new ticket emails…';
      const wait = progress.waiting ? ' Gmail asked to slow down, so this waits a moment.' : '';
      return `Read ${progress.read} email${progress.read === 1 ? '' : 's'}, ${progress.remaining ?? 'some'} to go…${wait}`;
    }
    if (progress) {
      const skipped = progress.skipped ? ` Gmail would not open ${progress.skipped}.` : '';
      if (!progress.read) return `No new ticket emails.${skipped}`;
      return `Read ${progress.read} new email${progress.read === 1 ? '' : 's'}; ${progress.added ? `${progress.added} new show${progress.added === 1 ? '' : 's'} below` : 'no new shows'}.${skipped}`;
    }
    if (status.scannedThrough) return `Read up to mail from ${dayLabel(status.scannedThrough)}${status.lastCheckedAt ? `, last checked ${dayLabel(status.lastCheckedAt)}` : ''}.`;
    return 'Reads the ticket emails in your Gmail.';
  };

  return (
    <div className="space-y-1 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-400">{status.connected ? summary() : 'Connect Gmail to check for new ticket emails.'}</p>
        {status.connected ? (
          <button
            onClick={check}
            disabled={checking}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Check email
          </button>
        ) : (
          <a
            href="/api/gmail/connect"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
          >
            <Mail className="h-3.5 w-3.5" /> Connect Gmail
          </a>
        )}
      </div>
      {status.connected && status.account && <p className="text-[11px] text-zinc-600">{status.account}</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
};

const Row: React.FC<{ row: EmailImport; ticked?: boolean; onTick?: () => void; action?: React.ReactNode; note?: string }> = ({
  row,
  ticked,
  onTick,
  action,
  note,
}) => {
  const when = whenLabel(row) ?? row.dateText;
  const place = placeLabel(row);
  const facts = [row.tickets ? `${row.tickets} ticket${row.tickets === 1 ? '' : 's'}` : null, row.total].filter(Boolean).join(' · ');
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
      {onTick && (
        <button
          onClick={onTick}
          aria-pressed={ticked}
          aria-label={ticked ? 'I went (ticked)' : 'I went'}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
            ticked ? 'border-violet-500 bg-violet-600 text-white' : 'border-zinc-700 text-transparent hover:border-zinc-500'
          }`}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold text-zinc-100">{row.name}</p>
        {note && <p className="text-xs text-violet-300/80">{note}</p>}
        <p className="text-xs text-zinc-400">
          {[when ?? 'No date in the email', place].filter(Boolean).join(' · ')}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
          <EmailLink row={row} />
          {facts && <span>{facts}</span>}
          {row.flags.map((f) => (
            <span key={f} className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-300/90">
              {FLAG_LABELS[f]}
            </span>
          ))}
        </p>
      </div>
      {action}
    </div>
  );
};

const FIELD_LABELS: Record<MergeField, string> = { startDate: 'date', endDate: 'last day', venue: 'venue', city: 'city', ticketPrice: 'ticket price' };

// What a merge did, in a sentence: what it filled and what it left as yours.
function mergeSummary(name: string, filled: MergeField[], kept: Array<{ field: MergeField; yours: string; email: string }>): string {
  const parts = [`Merged into “${name}”.`];
  parts.push(filled.length ? `Filled ${filled.map((f) => FIELD_LABELS[f]).join(', ')} from the email.` : 'Nothing was empty to fill.');
  if (kept.length) parts.push(`Kept yours: ${kept.map((k) => `${FIELD_LABELS[k.field]} (the email says ${k.email})`).join(', ')}.`);
  return parts.join(' ');
}

// "Same as one of mine": pick the event you already entered for this
// email's show. Events nearest its date come first; typing narrows by name.
const MergePicker: React.FC<{ row: EmailImport; events: LoggedEvent[]; busy: boolean; onPick: (event: LoggedEvent) => void; onCancel: () => void }> = ({
  row,
  events,
  busy,
  onPick,
  onCancel,
}) => {
  const [q, setQ] = useState('');
  const options = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const at = row.startDate ? Date.parse(row.startDate) : undefined;
    const distance = (e: LoggedEvent) => {
      const d = e.startDate ? Date.parse(e.startDate) : e.year ? Date.UTC(e.year, 6, 1) : undefined;
      return at === undefined || d === undefined ? Infinity : Math.abs(d - at);
    };
    return events
      .filter((e) => words.every((w) => `${e.name} ${e.venue ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => distance(a) - distance(b) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [q, events, row.startDate]);
  return (
    <div className="space-y-2 rounded-xl border border-violet-500/30 bg-violet-950/20 p-3">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Which of your events is this?"
          className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none"
        />
        <button onClick={onCancel} className="text-xs text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
      </div>
      {!options.length && <p className="text-xs text-zinc-500">No event of yours matches.</p>}
      {options.map((e) => (
        <button
          key={e.id}
          disabled={busy}
          onClick={() => onPick(e)}
          className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-zinc-900 disabled:opacity-40"
        >
          <span className="block text-sm text-zinc-100">{e.name}</span>
          <span className="block text-xs text-zinc-500">{[whenLabel(e) ?? 'No date', placeLabel(e)].filter(Boolean).join(' · ')}</span>
        </button>
      ))}
      <p className="text-[11px] text-zinc-600">Only empty fields are filled from the email; what you entered stays as it is.</p>
    </div>
  );
};

export const ImportReview: React.FC<ImportReviewProps> = ({ imports, onChange, onAdded, events, onEventChanged, onClose, notice }) => {
  const [merging, setMerging] = useState<string | null>(null);
  const [merged, setMerged] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const { toReview, upcoming, logged, unreadable, skipped } = useMemo(() => {
    const open = imports.filter((r) => r.status === 'new');
    return {
      toReview: open.filter((r) => !r.eventId && !(r.startDate && r.startDate > today)),
      upcoming: open.filter((r) => !r.eventId && r.startDate && r.startDate > today),
      logged: imports.filter((r) => r.eventId),
      unreadable: imports.filter((r) => r.status === 'unreadable'),
      skipped: imports.filter((r) => r.status === 'skipped'),
    };
  }, [imports, today]);

  const years = useMemo(() => {
    const groups: Array<{ label: string; rows: EmailImport[] }> = [];
    for (const r of toReview) {
      const label = r.startDate?.slice(0, 4) ?? 'No date';
      const last = groups[groups.length - 1];
      if (last?.label === label) last.rows.push(r);
      else groups.push({ label, rows: [r] });
    }
    return groups;
  }, [toReview]);

  const toggle = (ids: string[], on?: boolean) =>
    setTicked((s) => {
      const next = new Set(s);
      const value = on ?? !ids.every((id) => next.has(id));
      for (const id of ids) value ? next.add(id) : next.delete(id);
      return next;
    });

  const merge = (changed: EmailImport[]) => {
    const byId = new Map(changed.map((r) => [r.id, r]));
    onChange(imports.map((r) => byId.get(r.id) ?? r));
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const chosen = [...toReview, ...upcoming].filter((r) => ticked.has(r.id)).map((r) => r.id);
  const add = () =>
    act(async () => {
      const res = await importsApi.add(chosen);
      merge(res.imports);
      onAdded(res.events);
      setTicked(new Set());
    });
  const skip = (ids: string[], restore = false) =>
    act(async () => {
      merge(await importsApi.skip(ids, restore));
      toggle(ids, false);
    });
  const mergeInto = (row: EmailImport, event: LoggedEvent) =>
    act(async () => {
      const res = await importsApi.merge(row.id, event.id);
      merge([res.import]);
      onEventChanged(res.event);
      toggle([row.id], false);
      setMerging(null);
      setMerged(mergeSummary(event.name, res.filled, res.kept));
    });
  const unmerge = (row: EmailImport) =>
    act(async () => {
      const res = await importsApi.unmerge(row.id);
      merge([res.import]);
      if (res.event) onEventChanged(res.event);
      setMerged(null);
    });
  const nameOf = (id?: string) => events.find((e) => e.id === id)?.name;
  // A row on the list, with "Same as one of mine" and its picker.
  const reviewRow = (r: EmailImport) => (
    <div key={r.id} className="space-y-2">
      <Row
        row={r}
        ticked={ticked.has(r.id)}
        onTick={() => toggle([r.id])}
        action={
          <button
            onClick={() => setMerging(merging === r.id ? null : r.id)}
            className="text-zinc-500 hover:text-violet-300"
            aria-label="Same as one of my events"
            title="Same as one of my events"
          >
            <GitMerge className="h-4 w-4" />
          </button>
        }
      />
      {merging === r.id && <MergePicker row={r} events={events} busy={busy} onPick={(e) => mergeInto(r, e)} onCancel={() => setMerging(null)} />}
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col border-l border-zinc-900 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Mail className="h-4 w-4 text-violet-400" /> From your ticket emails
              </h2>
              <p className="text-xs text-zinc-500">
                A ticket doesn't prove you went, so tick the ones you did. Each one is saved with a link to its email.
              </p>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          {notice && (
            <p
              className={`rounded-lg border p-2 text-sm ${
                notice === 'connected' ? 'border-violet-500/30 bg-violet-950/30 text-violet-200' : 'border-rose-500/30 bg-rose-950/30 text-rose-200'
              }`}
            >
              {notice === 'connected' ? 'Gmail is connected. Press Check email to look for new tickets.' : notice}
            </p>
          )}
          <CheckEmail onFound={onChange} />
          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}
          {merged && <p className="rounded-lg border border-violet-500/30 bg-violet-950/30 p-2 text-sm text-violet-200">{merged}</p>}

          {!toReview.length && <p className="text-sm text-zinc-500">Nothing left to review.</p>}
          {years.map((g) => (
            <section key={g.label} className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-bold text-zinc-300">
                  {g.label} <span className="text-xs font-normal text-zinc-600">{g.rows.length}</span>
                </h3>
                <button onClick={() => toggle(g.rows.map((r) => r.id))} className="text-xs text-zinc-400 hover:text-zinc-200">
                  {g.rows.every((r) => ticked.has(r.id)) ? 'Untick all' : `Tick all in ${g.label}`}
                </button>
              </div>
              {g.rows.map(reviewRow)}
            </section>
          ))}

          {upcoming.length > 0 && (
            <section className="space-y-2">
              <h3 className={sectionTitle}>Still ahead ({upcoming.length})</h3>
              <p className="text-xs text-zinc-600">
                Tick one to add it as upcoming: it isn't counted until you say you went, and once it's over the app asks. Unticked ones stay here.
              </p>
              {upcoming.map(reviewRow)}
            </section>
          )}

          {logged.length > 0 && (
            <details className="space-y-2">
              <summary className={`${sectionTitle} cursor-pointer`}>Already in your log ({logged.length})</summary>
              {logged.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  note={nameOf(r.eventId) && `${r.mergedFields ? 'Merged into' : r.status === 'added' ? 'Added as' : 'Matched to'} “${nameOf(r.eventId)}”`}
                  action={
                    r.mergedFields ? (
                      <button onClick={() => unmerge(r)} className="text-zinc-500 hover:text-zinc-200" aria-label="Undo merge" title="Undo merge">
                        <Undo2 className="h-4 w-4" />
                      </button>
                    ) : r.status === 'new' && events.some((e) => e.id === r.eventId) ? (
                      // Matched on its own: merging fills the event's empty fields from the email.
                      <button
                        disabled={busy}
                        onClick={() => mergeInto(r, events.find((e) => e.id === r.eventId)!)}
                        className="text-zinc-500 hover:text-violet-300 disabled:opacity-40"
                        aria-label="Merge into this event"
                        title="Merge into this event"
                      >
                        <GitMerge className="h-4 w-4" />
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </details>
          )}

          {skipped.length > 0 && (
            <details className="space-y-2">
              <summary className={`${sectionTitle} cursor-pointer`}>Left out ({skipped.length})</summary>
              {skipped.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  action={
                    <button onClick={() => skip([r.id], true)} className="text-zinc-500 hover:text-zinc-200" aria-label="Put back">
                      <Undo2 className="h-4 w-4" />
                    </button>
                  }
                />
              ))}
            </details>
          )}

          {unreadable.length > 0 && (
            <details className="space-y-2">
              <summary className={`${sectionTitle} cursor-pointer`}>Couldn't read ({unreadable.length})</summary>
              <p className="text-xs text-zinc-600">Ticket emails in a layout the app doesn't know yet. Open one and add it by typing a line.</p>
              {unreadable.map((r) => (
                <Row key={r.id} row={{ ...r, dateText: undefined }} />
              ))}
            </details>
          )}
        </div>

        {(toReview.length > 0 || upcoming.length > 0) && (
          <div className="flex items-center justify-between gap-3 border-t border-zinc-900 p-4">
            <button
              onClick={() => skip(chosen)}
              disabled={busy || !chosen.length}
              className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
            >
              Leave these out
            </button>
            <button
              onClick={add}
              disabled={busy || !chosen.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Add {chosen.length || ''} event{chosen.length === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
