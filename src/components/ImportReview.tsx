import React, { useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2, Mail, Undo2, X } from 'lucide-react';
import { EmailImport, importsApi, LoggedEvent } from '../services/lineupApi';
import { placeLabel, whenLabel } from '../services/format';

// Stage 1 from email: shows found in your ticket emails. A ticket is not
// proof you went, so nothing starts ticked and nothing is saved until you
// press Add. See ARCHITECTURE.md ("Stage 1 from email").

interface ImportReviewProps {
  imports: EmailImport[];
  onChange: (imports: EmailImport[]) => void;
  onAdded: (events: LoggedEvent[]) => void;
  onClose: () => void;
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

const Row: React.FC<{ row: EmailImport; ticked?: boolean; onTick?: () => void; action?: React.ReactNode }> = ({ row, ticked, onTick, action }) => {
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

export const ImportReview: React.FC<ImportReviewProps> = ({ imports, onChange, onAdded, onClose }) => {
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

  const chosen = toReview.filter((r) => ticked.has(r.id)).map((r) => r.id);
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
          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}

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
              {g.rows.map((r) => (
                <Row key={r.id} row={r} ticked={ticked.has(r.id)} onTick={() => toggle([r.id])} />
              ))}
            </section>
          ))}

          {upcoming.length > 0 && (
            <section className="space-y-2">
              <h3 className={sectionTitle}>Still ahead ({upcoming.length})</h3>
              <p className="text-xs text-zinc-600">These come back here for review once their date has passed.</p>
              {upcoming.map((r) => (
                <Row key={r.id} row={r} />
              ))}
            </section>
          )}

          {logged.length > 0 && (
            <details className="space-y-2">
              <summary className={`${sectionTitle} cursor-pointer`}>Already in your log ({logged.length})</summary>
              {logged.map((r) => (
                <Row key={r.id} row={r} />
              ))}
            </details>
          )}

          {skipped.length > 0 && (
            <details className="space-y-2">
              <summary className={`${sectionTitle} cursor-pointer`}>Didn't go ({skipped.length})</summary>
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

        {toReview.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-zinc-900 p-4">
            <button
              onClick={() => skip(chosen)}
              disabled={busy || !chosen.length}
              className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
            >
              I didn't go to these
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
