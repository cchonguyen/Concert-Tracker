import { Dialog } from './ui/Dialog';
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileUp, X } from 'lucide-react';
import { useVault } from './VaultContext';
import { Equalizer } from './ui/Equalizer';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';
import { EmailImport, entitiesApi, eventsApi, importsApi, LoggedEvent } from '../services/lineupApi';
import type { NameIndex } from '../server/entities/link';
import { placeLabel, whenLabel } from '../services/format';
import { splitCity } from '../server/events/regions';
import {
  Choice,
  fillPatch,
  findMatches,
  ImportResult,
  ListField,
  ListRow,
  Matches,
  norm,
  readList,
  ReadList,
  readTable,
  runImport,
  Target,
  targetId,
} from '../services/listImport';

// Your own list of past events (a Notion or spreadsheet CSV) read into rows
// you check before anything is saved. Rows that are the same event as one in
// your log, or a show waiting in the email review, are folded into it; rows
// that only share a day with one wait for you to say. See ARCHITECTURE.md
// ("Importing a list"). Rows from this app's own export carry an ID and are
// folded into that event the same way: the app is the source of truth, so a
// file only fills what an event lacks.

interface ListImportProps {
  events: LoggedEvent[];
  imports: EmailImport[];
  onDone: () => void;
  onClose: () => void;
}

const FIELD_LABELS: Record<ListField, string> = {
  name: 'event',
  startDate: 'date',
  endDate: 'end date',
  year: 'year',
  venue: 'venue',
  city: 'city',
  region: 'state',
  country: 'country',
  seen: 'acts seen',
  companions: 'went with',
  rating: 'rating',
  ticketPrice: 'ticket price',
  format: 'format',
  series: 'series',
  weekend: 'weekend',
  notes: 'notes',
  id: 'event ID',
};

const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';
const control =
  'min-h-11 sm:min-h-9 w-full rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-xs text-text focus:border-accent focus:outline-none';

const targetLabel = (t: Target) => {
  const f = t.kind === 'event' ? t.event : t.row;
  const when = whenLabel(f) ?? 'no date';
  return t.kind === 'event' ? `${f.name} (${when}, in your log)` : `${f.name} (${when}, ${t.row.seller} email)`;
};

const baseOf = (t: Target): Partial<LoggedEvent> =>
  t.kind === 'event'
    ? t.event
    : { startDate: t.row.startDate, endDate: t.row.endDate, venue: t.row.venue, ...splitCity({ city: t.row.city }) };

const choiceValue = (c: Choice | undefined) => (!c ? '' : c.kind === 'into' ? targetId(c.target) : c.kind);

// The same event is folded in; a day shared with another name waits for you.
function initialChoices(read: ReadList, events: LoggedEvent[], imports: EmailImport[]): Record<string, Choice | undefined> {
  const initial: Record<string, Choice | undefined> = {};
  for (const row of read.rows) {
    const m = findMatches(row, events, imports);
    initial[row.id] = m.exact ? { kind: 'into', target: m.exact } : m.nearby.length ? undefined : { kind: 'new' };
  }
  return initial;
}

export const ListImport: React.FC<ListImportProps> = ({ events, imports, onDone, onClose }) => {
  const vault = useVault();
  const [file, setFile] = useState<string | null>(null);
  const [list, setList] = useState<ReadList | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice | undefined>>({});
  // Without the entity tables this stays empty and names match as written.
  const [names, setNames] = useState<NameIndex>({});
  useEffect(() => {
    entitiesApi.names().then(setNames, () => setNames({}));
  }, []);
  const [leaveOut, setLeaveOut] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const out: Record<string, Matches> = {};
    for (const row of list?.rows ?? []) out[row.id] = findMatches(row, events, imports);
    return out;
  }, [list, events, imports]);

  const people = useMemo(() => {
    const seen = new Map<string, { name: string; count: number }>();
    for (const row of list?.rows ?? []) {
      for (const c of row.companions) {
        const p = seen.get(norm(c)) ?? { name: c, count: 0 };
        p.count++;
        seen.set(norm(c), p);
      }
    }
    return [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [list]);

  const open = async (f: File) => {
    setError(null);
    setResult(null);
    const read = readList(await f.text());
    setFile(f.name);
    setList(read);
    if (read.error) setError(read.error);
    setChoices(initialChoices(read, events, imports));
    setLeaveOut(new Set());
  };

  const rows = list?.rows ?? [];
  const groups = useMemo(() => {
    const choose: ListRow[] = [];
    const merge: ListRow[] = [];
    const fresh: ListRow[] = [];
    let same = 0;
    for (const row of rows) {
      const m = matches[row.id];
      if (m?.exact) {
        // A row from the app's own export that adds nothing is just counted.
        if (m.exported && !fillPatch(row, baseOf(m.exact), leaveOut, names).adds.length) same++;
        else merge.push(row);
      } else if (m?.nearby.length) choose.push(row);
      else fresh.push(row);
    }
    return { choose, merge, fresh, same };
  }, [rows, matches, leaveOut, names]);

  const undecided = rows.filter((r) => !choices[r.id]).length;
  const chosen = rows.filter((r) => choices[r.id] && choices[r.id]!.kind !== 'skip');

  const setChoice = (row: ListRow, value: string) => {
    const m = matches[row.id];
    const targets = [m?.exact, ...(m?.nearby ?? [])].filter((t): t is Target => Boolean(t));
    const target = targets.find((t) => targetId(t) === value);
    const next: Choice | undefined =
      value === 'new'
          ? { kind: 'new' }
          : value === 'skip'
            ? { kind: 'skip' }
            : target
              ? { kind: 'into', target }
              : undefined;
    setChoices((c) => ({ ...c, [row.id]: next }));
  };

  const go = async () => {
    setError(null);
    // A locked vault cannot encrypt, and notes and companions are never dropped quietly.
    if (vault.status === 'locked' && chosen.some((row) => row.notes || row.companions.some((c) => !leaveOut.has(norm(c))))) {
      setError('Your Private Vault is locked. Please unlock your vault to encrypt and import your personal notes and companions.');
      return;
    }
    setBusy(true);
    try {
      const res = await runImport(
        chosen.map((row) => ({ row, choice: choices[row.id]! })),
        {
          create: eventsApi.create,
          // With an unlocked vault, notes are encrypted here before they are sent.
          update: async (id, patch) =>
            eventsApi.update(id, typeof patch.notes === 'string' && vault.status === 'unlocked' ? { ...patch, notes: await vault.encryptNote(patch.notes) } : patch),
          addEmail: importsApi.add,
          restoreEmail: (ids) => importsApi.skip(ids, true),
        },
        leaveOut,
        names,
      );
      onDone();
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (row: ListRow) => {
    const m = matches[row.id];
    const targets = [m?.exact, ...(m?.nearby ?? [])].filter((t): t is Target => Boolean(t));
    const choice = choices[row.id];
    const adds = choice?.kind === 'into' ? fillPatch(row, baseOf(choice.target), leaveOut, names).adds : null;
    const when = whenLabel(row) ?? (row.year ? String(row.year) : null);
    const people = row.companions.filter((c) => !leaveOut.has(norm(c)));
    return (
      <Ledger.Row key={row.id} edge={row.problems.length ? 'needs' : 'none'} className="flex-col items-stretch gap-2 p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-text">{row.name}</p>
          <p className="font-mono text-xs tabular-nums text-text-muted">
            {[when ? `${when}${row.yearFromName ? ' (year from the name)' : ''}` : 'No date', placeLabel(row)].filter(Boolean).join(' · ')}
          </p>
          {(row.seen.length > 0 || people.length > 0) && (
            <p className="text-[11px] text-text-muted">
              {[row.seen.length ? `Saw ${row.seen.join(', ')}` : null, people.length ? `with ${people.join(', ')}` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {row.lines.length > 1 && <p className="font-mono text-[11px] tabular-nums text-text-muted">Combined from lines {row.lines.join(' and ')} of the file.</p>}
          {row.problems.map((p) => (
            <p key={p} className="flex items-start gap-1 text-[11px] text-warn">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {p}
            </p>
          ))}
        </div>
        <select value={choiceValue(choice)} onChange={(e) => setChoice(row, e.target.value)} className={control}>
          {!choice && <option value="">Choose: same event or a different one?</option>}
          {targets.map((t) => (
            <option key={targetId(t)} value={targetId(t)}>
              Same event as {targetLabel(t)}
            </option>
          ))}
          <option value="new">Add as a new event</option>
          <option value="skip">Don't import</option>
        </select>
        {adds && (
          <p className="text-[11px] text-text-muted">
            {adds.length ? `Adds ${adds.join(', ')}. Nothing already there changes.` : 'Nothing new to add.'}
          </p>
        )}
      </Ledger.Row>
    );
  };

  const renderSection = (title: string, note: string, rows: ListRow[]) =>
    rows.length ? (
      <section className="space-y-2">
        <h3 className={sectionTitle}>
          {title} (<span className="font-mono tabular-nums">{rows.length}</span>)
        </h3>
        <p className="text-xs text-text-muted">{note}</p>
        <Ledger>{rows.map(renderRow)}</Ledger>
      </section>
    ) : null;

  return (
    <Dialog title="Import a list" onClose={onClose}>
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 poster-head text-2xl text-text">
              <FileUp className="h-4 w-4 text-accent" /> Import a list
            </h2>
            <p className="text-xs text-text-muted">
              A CSV of events you went to, from Notion, a spreadsheet or this app's export. Nothing is saved until you press Import.
              It only adds new events and fills empty fields, acts and people on events you already have. It never changes what your
              log already says.
            </p>
          </div>
          <button onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-text-muted hover:text-text" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text hover:bg-surface-2 sm:min-h-9">
          <FileUp className="h-3.5 w-3.5" /> {file ? `${file} (choose another)` : 'Choose a CSV file'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f);
              e.target.value = '';
            }}
          />
        </label>

        {error && <Notice tone="error">{error}</Notice>}

        {result && (
          <Notice tone="success">
            <div className="space-y-1">
            <p>
              {result.created} new event{result.created === 1 ? '' : 's'}, {result.merged} merged into existing ones
              {result.unchanged ? `, ${result.unchanged} already complete` : ''}.
            </p>
            {result.failed.map((f) => (
              <p key={f.row.id} className="text-bad">
                {f.row.name}: {f.error}
              </p>
            ))}
            </div>
          </Notice>
        )}

        {list && !list.error && !result && (
          <>
            <p className="text-xs text-text-muted">
              Read <span className="font-mono tabular-nums">{rows.length}</span> event{rows.length === 1 ? '' : 's'}
              {list.combined ? `, after combining ${list.combined} repeated row${list.combined === 1 ? '' : 's'}` : ''}. Columns:{' '}
              {list.columns.map((c) => `${c.header} → ${c.field ? FIELD_LABELS[c.field] : 'not imported'}`).join(' · ')}
              {groups.same ? `. ${groups.same} row${groups.same === 1 ? '' : 's'} with nothing new.` : ''}
            </p>

            {people.length > 0 && (
              <section className="space-y-2">
                <h3 className={sectionTitle}>Are you one of these?</h3>
                <p className="text-xs text-text-muted">"Went with" lists other people. Tap your own name to leave it out.</p>
                <div className="flex flex-wrap gap-1.5">
                  {people.map(([key, p]) => (
                    <button
                      key={key}
                      onClick={() =>
                        setLeaveOut((s) => {
                          const next = new Set(s);
                          next.has(key) ? next.delete(key) : next.add(key);
                          return next;
                        })
                      }
                      className={`min-h-11 rounded-full border px-3 py-1 text-xs sm:min-h-9 ${
                        leaveOut.has(key) ? 'border-transparent bg-neutral-soft text-text-muted line-through' : 'border-transparent bg-accent-tint text-text'
                      }`}
                    >
                      {p.name} <span className="font-mono tabular-nums text-text-muted">{p.count}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {renderSection(
              'Same day as another event',
              "These share a day with something in your log or your email review under another name. Say whether they're the same event.",
              groups.choose,
            )}
            {renderSection(
              'Already in your log or email review',
              "Folded into the matching event (rows from this app's export, by their ID): only its empty fields are filled, and acts and people it doesn't have yet are added.",
              groups.merge,
            )}
            {renderSection(
              'New',
              "Each becomes an event with the file's fields.",
              groups.fresh,
            )}
          </>
        )}
      </div>

      {list && !list.error && !result && rows.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-line p-4">
          <span className="text-xs text-text-muted">
            {undecided ? `${undecided} still need your choice and won't be imported yet.` : ''}
          </span>
          <button
            onClick={go}
            disabled={busy || !chosen.length}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40 sm:min-h-9"
          >
            {busy && <Equalizer size="sm" />}
            {`Import ${chosen.length || ''} event${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </Dialog>
  );
};
