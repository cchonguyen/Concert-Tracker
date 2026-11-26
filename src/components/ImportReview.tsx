import { Dialog } from './ui/Dialog';
import { Tooltip } from './ui/Tooltip';
import { useToast } from './ui/Toast';
import React, { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, GitMerge, Mail, RefreshCw, Undo2, X } from 'lucide-react';
import { EmailImport, EmailScanStatus, importsApi, LoggedEvent } from '../services/lineupApi';
import type { MergeField } from '../server/events/email/types';
import { placeLabel, whenLabel } from '../services/format';
import { BrowserScan } from './BrowserScan';
import { Equalizer } from './ui/Equalizer';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';
import { useIsOwner } from './MeContext';

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
  cancelled: 'Canceled',
  transferred_away: 'Tickets sent to someone else',
};

const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';

const EmailLink: React.FC<{ row: EmailImport }> = ({ row }) => {
  const link = row.sources.name?.link ?? row.messages.find((m) => m.link)?.link;
  return link ? (
    <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-accent">
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
  const owner = useIsOwner();
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
    <div className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
      {/* The server's Gmail connection is one stored sign-in: the owner's. Members scan in the browser below. */}
      {owner && (
        <details className="space-y-2">
          <summary className="cursor-pointer text-xs text-text-muted">More options</summary>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-text-muted">{status.connected ? summary() : 'Connect Gmail to check for new ticket emails.'}</p>
              {status.connected ? (
                <button
                  onClick={check}
                  disabled={checking}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-line-strong px-3 py-1.5 text-xs font-semibold text-text hover:border-accent disabled:opacity-40 sm:min-h-9"
                >
                  {checking ? <Equalizer size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Check email
                </button>
              ) : (
                <a
                  href="/api/gmail/connect"
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control bg-accent-fill px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-fill sm:min-h-9"
                >
                  <Mail className="h-3.5 w-3.5" /> Connect Gmail
                </a>
              )}
            </div>
            {status.connected && status.account && <p className="text-[11px] text-text-muted">{status.account}</p>}
            {error && <p className="text-xs text-bad">{error}</p>}
          </div>
        </details>
      )}
      <Notice tone="info">
        Google may show an &ldquo;unverified app&rdquo; screen when you connect. This is a personal app, so choose Advanced, then continue. Prefer not to connect Gmail?
        You can also import a CSV spreadsheet or add shows by hand.
      </Notice>
      <BrowserScan status={status} onFound={onFound} />
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
    <Ledger.Row edge={row.flags.length > 0 ? 'needs' : 'none'} className="items-start gap-3 p-3">
      {onTick && (
        <button
          onClick={onTick}
          aria-pressed={ticked}
          aria-label={ticked ? 'I went (ticked)' : 'I went'}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
            ticked ? 'border-accent-fill bg-accent-fill text-on-accent' : 'border-line-strong text-transparent hover:border-accent'
          }`}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold text-text">{row.name}</p>
        {note && <p className="text-xs text-accent">{note}</p>}
        <p className="font-mono text-xs tabular-nums text-text-muted">
          {[when ?? 'No date in the email', place].filter(Boolean).join(' · ')}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted">
          <EmailLink row={row} />
          {facts && <span className="font-mono tabular-nums">{facts}</span>}
          {row.flags.map((f) => (
            <span key={f} className="rounded bg-warn/10 px-1.5 py-0.5 text-warn">
              {FLAG_LABELS[f]}
            </span>
          ))}
        </p>
      </div>
      {action}
    </Ledger.Row>
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
    <div className="space-y-2 rounded-card border border-accent-tint-line bg-accent-tint p-3">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          aria-label="Which of your events is this?"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Which of your events is this?"
          className="min-h-11 min-w-0 flex-1 rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9"
        />
        <button onClick={onCancel} className="min-h-11 rounded-control px-1.5 text-xs text-text-muted hover:text-text sm:min-h-9">
          Cancel
        </button>
      </div>
      {!options.length && <p className="text-xs text-text-muted">No event of yours matches.</p>}
      {options.map((e) => (
        <button
          key={e.id}
          disabled={busy}
          onClick={() => onPick(e)}
          className="block min-h-11 w-full rounded-control px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-40 sm:min-h-9"
        >
          <span className="block text-sm text-text">{e.name}</span>
          <span className="block font-mono text-xs tabular-nums text-text-muted">{[whenLabel(e) ?? 'No date', placeLabel(e)].filter(Boolean).join(' · ')}</span>
        </button>
      ))}
      <p className="text-[11px] text-text-muted">Only empty fields are filled from the email; what you entered stays as it is.</p>
    </div>
  );
};

export const ImportReview: React.FC<ImportReviewProps> = ({ imports, onChange, onAdded, events, onEventChanged, onClose, notice }) => {
  const [merging, setMerging] = useState<string | null>(null);
  const toast = useToast();
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
      toast({ message: mergeSummary(event.name, res.filled, res.kept) });
    });
  const unmerge = (row: EmailImport) =>
    act(async () => {
      const res = await importsApi.unmerge(row.id);
      merge([res.import]);
      if (res.event) onEventChanged(res.event);
      toast({ message: 'Merge undone' });
    });
  const nameOf = (id?: string) => events.find((e) => e.id === id)?.name;
  // A row on the list, with "Same as one of mine" and its picker.
  const reviewRow = (r: EmailImport) => (
    <div key={r.id}>
      <Row
        row={r}
        ticked={ticked.has(r.id)}
        onTick={() => toggle([r.id])}
        action={
          <button
            onClick={() => setMerging(merging === r.id ? null : r.id)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-text-muted hover:text-accent"
            aria-label="Same as one of my events"
            title="Same as one of my events"
          >
            <GitMerge className="h-4 w-4" />
          </button>
        }
      />
      {merging === r.id && (
        <div className="p-2">
          <MergePicker row={r} events={events} busy={busy} onPick={(e) => mergeInto(r, e)} onCancel={() => setMerging(null)} />
        </div>
      )}
    </div>
  );

  return (
    <Dialog title="Review import" onClose={onClose}>
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-display text-xl font-normal text-text">
              <Mail className="h-4 w-4 text-accent" /> From your ticket emails
            </h2>
            <p className="text-xs text-text-muted">
              A ticket doesn't prove you went, so tick the ones you did. Each one is saved with a link to its email.
            </p>
          </div>
          <button onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-text-muted hover:text-text" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {notice && (
          <p
            className={`rounded-card border p-2 text-sm ${
              notice === 'connected' ? 'border-accent-tint-line bg-accent-tint text-accent' : 'border-bad/45 bg-bad/10 text-bad'
            }`}
          >
            {notice === 'connected' ? 'Gmail is connected. Press Check email to look for new tickets.' : notice}
          </p>
        )}
        <CheckEmail onFound={onChange} />
        {error && <p className="rounded-card border border-bad/45 bg-bad/10 p-2 text-sm text-bad">{error}</p>}

        {!toReview.length && <p className="text-sm text-text-muted">Nothing left to review.</p>}
        {years.map((g) => (
          <section key={g.label} className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-bold text-text">
                {g.label} <span className="font-mono text-xs font-normal tabular-nums text-text-muted">{g.rows.length}</span>
              </h3>
              <button onClick={() => toggle(g.rows.map((r) => r.id))} className="min-h-11 rounded-control px-1.5 text-xs text-text-muted hover:text-text sm:min-h-9">
                {g.rows.every((r) => ticked.has(r.id)) ? 'Untick all' : `Tick all in ${g.label}`}
              </button>
            </div>
            <Ledger>{g.rows.map(reviewRow)}</Ledger>
          </section>
        ))}

        {upcoming.length > 0 && (
          <section className="space-y-2">
            <h3 className={sectionTitle}>Still ahead (<span className="font-mono tabular-nums">{upcoming.length}</span>)</h3>
            <p className="text-xs text-text-muted">
              Tick one to add it as upcoming: it isn't counted until you say you went, and once it's over the app asks. Unticked ones stay here.
            </p>
            <Ledger>{upcoming.map(reviewRow)}</Ledger>
          </section>
        )}

        {logged.length > 0 && (
          <details className="space-y-2">
            <summary className={`${sectionTitle} cursor-pointer`}>Already in your log (<span className="font-mono tabular-nums">{logged.length}</span>)</summary>
            <Ledger>
              {logged.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  note={nameOf(r.eventId) && `${r.mergedFields ? 'Merged into' : r.status === 'added' ? 'Added as' : 'Matched to'} “${nameOf(r.eventId)}”`}
                  action={
                    r.mergedFields ? (
                      <Tooltip label="Undo merge">
                        <button onClick={() => unmerge(r)} className="flex h-9 w-9 items-center justify-center rounded-control text-text-muted hover:text-text" aria-label="Undo merge">
                          <Undo2 className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    ) : r.status === 'new' && events.some((e) => e.id === r.eventId) ? (
                      // Matched on its own: merging fills the event's empty fields from the email.
                      <Tooltip label="Merge into this event">
                        <button
                          disabled={busy}
                          onClick={() => mergeInto(r, events.find((e) => e.id === r.eventId)!)}
                          className="flex h-9 w-9 items-center justify-center rounded-control text-text-muted hover:text-accent disabled:opacity-40"
                          aria-label="Merge into this event"
                        >
                          <GitMerge className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    ) : undefined
                  }
                />
              ))}
            </Ledger>
          </details>
        )}

        {skipped.length > 0 && (
          <details className="space-y-2">
            <summary className={`${sectionTitle} cursor-pointer`}>Left out (<span className="font-mono tabular-nums">{skipped.length}</span>)</summary>
            <Ledger>
              {skipped.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  action={
                    <button onClick={() => skip([r.id], true)} className="flex h-9 w-9 items-center justify-center rounded-control text-text-muted hover:text-text" aria-label="Put back">
                      <Undo2 className="h-4 w-4" />
                    </button>
                  }
                />
              ))}
            </Ledger>
          </details>
        )}

        {unreadable.length > 0 && (
          <details className="space-y-2">
            <summary className={`${sectionTitle} cursor-pointer`}>Couldn't read (<span className="font-mono tabular-nums">{unreadable.length}</span>)</summary>
            <p className="text-xs text-text-muted">Ticket emails in a layout the app doesn't know yet. Open one and add it by typing a line.</p>
            <Ledger>
              {unreadable.map((r) => (
                <Row key={r.id} row={{ ...r, dateText: undefined }} />
              ))}
            </Ledger>
          </details>
        )}
      </div>

      {(toReview.length > 0 || upcoming.length > 0) && (
        <div className="flex items-center justify-between gap-3 border-t border-line p-4">
          <button
            onClick={() => skip(chosen)}
            disabled={busy || !chosen.length}
            className="min-h-11 rounded-control px-1.5 text-xs text-text-muted hover:text-text disabled:opacity-40 sm:min-h-9"
          >
            Leave these out
          </button>
          <button
            onClick={add}
            disabled={busy || !chosen.length}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40 sm:min-h-9"
          >
            {busy && <Equalizer size="sm" />}
            Add {chosen.length || ''} event{chosen.length === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </Dialog>
  );
};
