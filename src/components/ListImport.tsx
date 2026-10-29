import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileUp, Loader2, X } from 'lucide-react';
import { useVault } from './VaultContext';
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

const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-500';
const control =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none';

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
    setBusy(true);
    setError(null);
    try {
      const res = await runImport(
        chosen.map((row) => ({ row, choice: choices[row.id]! })),
        {
          create: eventsApi.create,
          // With a vault on, notes are encrypted here; while it is locked they are left out.
          update: async (id, patch) => {
            if (typeof patch.notes !== 'string' || vault.status === 'off' || vault.status === 'unavailable') return eventsApi.update(id, patch);
            const { notes, ...rest } = patch;
            return eventsApi.update(id, vault.status === 'unlocked' ? { ...rest, notes: await vault.encryptNote(notes) } : rest);
          },
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
      <div key={row.id} className="space-y-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-zinc-100">{row.name}</p>
          <p className="text-xs text-zinc-400">
            {[when ? `${when}${row.yearFromName ? ' (year from the name)' : ''}` : 'No date', placeLabel(row)].filter(Boolean).join(' · ')}
          </p>
          {(row.seen.length > 0 || people.length > 0) && (
            <p className="text-[11px] text-zinc-500">
              {[row.seen.length ? `Saw ${row.seen.join(', ')}` : null, people.length ? `with ${people.join(', ')}` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {row.lines.length > 1 && <p className="text-[11px] text-zinc-500">Combined from lines {row.lines.join(' and ')} of the file.</p>}
          {row.problems.map((p) => (
            <p key={p} className="flex items-start gap-1 text-[11px] text-amber-300/90">
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
          <p className="text-[11px] text-zinc-500">
            {adds.length ? `Adds ${adds.join(', ')}. Nothing already there changes.` : 'Nothing new to add.'}
          </p>
        )}
      </div>
    );
  };

  const renderSection = (title: string, note: string, rows: ListRow[]) =>
    rows.length ? (
      <section className="space-y-2">
        <h3 className={sectionTitle}>
          {title} ({rows.length})
        </h3>
        <p className="text-xs text-zinc-600">{note}</p>
        {rows.map(renderRow)}
      </section>
    ) : null;

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
                <FileUp className="h-4 w-4 text-violet-400" /> Import a list
              </h2>
              <p className="text-xs text-zinc-500">
                A CSV of events you went to, from Notion, a spreadsheet or this app's export. Nothing is saved until you press Import.
                The file only adds: new events, and empty fields, acts and people on events you already have. It never changes what your
                log already says.
              </p>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100">
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

          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 text-sm text-rose-200">{error}</p>}

          {result && (
            <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 text-sm text-emerald-200">
              <p>
                {result.created} new event{result.created === 1 ? '' : 's'}, {result.merged} merged into existing ones
                {result.unchanged ? `, ${result.unchanged} already complete` : ''}.
              </p>
              {result.failed.map((f) => (
                <p key={f.row.id} className="text-rose-200">
                  {f.row.name}: {f.error}
                </p>
              ))}
            </div>
          )}

          {list && !list.error && !result && (
            <>
              <p className="text-xs text-zinc-400">
                Read {rows.length} event{rows.length === 1 ? '' : 's'}
                {list.combined ? `, after combining ${list.combined} repeated row${list.combined === 1 ? '' : 's'}` : ''}. Columns:{' '}
                {list.columns.map((c) => `${c.header} → ${c.field ? FIELD_LABELS[c.field] : 'not imported'}`).join(' · ')}
                {groups.same ? `. ${groups.same} row${groups.same === 1 ? '' : 's'} with nothing new.` : ''}
              </p>

              {people.length > 0 && (
                <section className="space-y-2">
                  <h3 className={sectionTitle}>Are you one of these?</h3>
                  <p className="text-xs text-zinc-600">"Went with" lists other people. Tap your own name to leave it out.</p>
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
                        className={`rounded-full border px-2.5 py-1 text-xs ${
                          leaveOut.has(key) ? 'border-zinc-800 text-zinc-600 line-through' : 'border-violet-500/50 text-violet-200'
                        }`}
                      >
                        {p.name} <span className="text-zinc-500">{p.count}</span>
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
          <div className="flex items-center justify-between gap-3 border-t border-zinc-900 p-4">
            <span className="text-xs text-zinc-500">
              {undecided ? `${undecided} still need your choice and won't be imported yet.` : ''}
            </span>
            <button
              onClick={go}
              disabled={busy || !chosen.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {`Import ${chosen.length || ''} event${chosen.length === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
