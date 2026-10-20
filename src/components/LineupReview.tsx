import React, { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Plus, X } from 'lucide-react';
import type { Attendance, Edition, LookupJob } from '../server/lineup/types';
import type { RejectReason } from '../server/lineup/learning';
import { lineupApi, SOURCE_LABELS } from '../services/lineupApi';

interface LineupReviewProps {
  job: LookupJob;
  onClose: () => void;
  onSaved: (edition: Edition, attendance: Attendance | null) => void;
}

interface Row {
  key?: string;
  name: string;
  originalName?: string;
  accepted: boolean;
  rejectReason: RejectReason;
  seen: boolean;
  days: string[];
  stages: string[];
  confidence: number;
  flagged: boolean;
  status: 'billed' | 'performed';
  sources: NonNullable<LookupJob['candidate']>['performers'][number]['sources'];
}

function datesBetween(start?: string, end?: string): string[] {
  if (!start) return [];
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end || start}T00:00:00Z`);
  while (cur <= last && out.length < 14) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const input =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none';

export const LineupReview: React.FC<LineupReviewProps> = ({ job, onClose, onSaved }) => {
  const candidate = job.candidate;
  const [facts, setFacts] = useState({
    name: candidate?.facts.name ?? job.input.eventName,
    startDate: candidate?.facts.startDate ?? job.input.startDate ?? '',
    endDate: candidate?.facts.endDate ?? job.input.endDate ?? '',
    venue: candidate?.facts.venue ?? job.input.venue ?? '',
    city: candidate?.facts.city ?? job.input.city ?? '',
    country: candidate?.facts.country ?? job.input.country ?? '',
  });
  const [rows, setRows] = useState<Row[]>(
    (candidate?.performers ?? []).map((p) => ({
      key: p.key,
      name: p.name,
      originalName: p.name,
      accepted: !p.flagged,
      rejectReason: 'not_an_act',
      seen: false,
      days: p.days,
      stages: p.stages,
      confidence: p.confidence,
      flagged: p.flagged,
      status: p.status,
      sources: p.sources,
    })),
  );
  const [filter, setFilter] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [newAct, setNewAct] = useState('');
  const [attended, setAttended] = useState<string[]>([]);
  const [rating, setRating] = useState(5);
  const [ticketPrice, setTicketPrice] = useState('');
  const [companions, setCompanions] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => datesBetween(facts.startDate, facts.endDate), [facts.startDate, facts.endDate]);
  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (!onlyFlagged || row.flagged) && row.name.toLowerCase().includes(filter.toLowerCase()));

  const update = (index: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const setAll = (patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (visible.some((v) => v.index === i) ? { ...r, ...patch } : r)));

  const addAct = () => {
    const name = newAct.trim();
    if (!name) return;
    setRows((rs) => [
      ...rs,
      { name, accepted: true, rejectReason: 'not_an_act', seen: true, days: [], stages: [], confidence: 1, flagged: false, status: 'billed', sources: [] },
    ]);
    setNewAct('');
  };

  const save = async () => {
    setError(null);
    if (!facts.name.trim()) return setError('Event name is required.');
    if (!facts.startDate) return setError('Add the start date so the event can go in your archive.');
    setSaving(true);
    try {
      const { edition, attendance } = await lineupApi.confirm(job.id, {
        facts,
        performers: rows.map((r) => ({
          key: r.key,
          name: r.name,
          accepted: r.accepted,
          rejectReason: r.accepted ? undefined : r.rejectReason,
          seen: r.accepted && r.seen,
          days: r.days,
          stages: r.stages,
        })),
        attendance: {
          daysAttended: attended.length ? attended : days,
          rating,
          ticketPrice: ticketPrice ? Number(ticketPrice) : undefined,
          companions: companions.split(',').map((c) => c.trim()).filter(Boolean),
          notes: notes || undefined,
        },
      });
      onSaved(edition, attendance);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const seenCount = rows.filter((r) => r.accepted && r.seen).length;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-5xl space-y-5 rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-white">Review lineup</h2>
            <p className="text-xs text-zinc-400">
              {candidate?.cached
                ? 'This edition was confirmed before, so it came straight from your database.'
                : 'Every act below was found on at least one source page. Untick anything wrong, fix spellings, and tick the sets you saw. Your fixes are remembered for next time.'}
              {candidate?.droppedCount ? ` ${candidate.droppedCount} entries were filtered out by your earlier corrections.` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <label className="col-span-2 sm:col-span-3 space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Event</span>
            <input className={input} value={facts.name} onChange={(e) => setFacts({ ...facts, name: e.target.value })} />
          </label>
          <label className="space-y-1 sm:col-span-1">
            <span className="text-[11px] font-semibold text-zinc-400">Start *</span>
            <input className={input} type="date" value={facts.startDate} onChange={(e) => setFacts({ ...facts, startDate: e.target.value })} />
          </label>
          <label className="space-y-1 sm:col-span-1">
            <span className="text-[11px] font-semibold text-zinc-400">End</span>
            <input className={input} type="date" value={facts.endDate} onChange={(e) => setFacts({ ...facts, endDate: e.target.value })} />
          </label>
          <label className="space-y-1 sm:col-span-1">
            <span className="text-[11px] font-semibold text-zinc-400">City</span>
            <input className={input} value={facts.city} onChange={(e) => setFacts({ ...facts, city: e.target.value })} />
          </label>
          <label className="col-span-2 sm:col-span-4 space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Venue</span>
            <input className={input} value={facts.venue} onChange={(e) => setFacts({ ...facts, venue: e.target.value })} />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Country</span>
            <input className={input} value={facts.country} onChange={(e) => setFacts({ ...facts, country: e.target.value })} />
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input className={`${input} max-w-xs`} placeholder="Filter acts" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="inline-flex items-center gap-1 text-zinc-400">
              <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Low evidence only
            </label>
            <span className="mx-1 text-zinc-700">|</span>
            <button className="text-zinc-300 hover:underline" onClick={() => setAll({ accepted: true })}>Accept shown</button>
            <button className="text-zinc-300 hover:underline" onClick={() => setAll({ seen: true })}>Saw all shown</button>
            <button className="text-zinc-300 hover:underline" onClick={() => setAll({ seen: false })}>Saw none shown</button>
            <span className="ml-auto text-zinc-500">
              {rows.filter((r) => r.accepted).length} accepted · {seenCount} seen
            </span>
          </div>

          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-900 text-left text-[11px] uppercase text-zinc-500">
                <tr>
                  <th className="p-2">Keep</th>
                  <th className="p-2">Act</th>
                  <th className="p-2">Sources</th>
                  <th className="p-2">Day / stage</th>
                  <th className="p-2">Saw it</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ row, index }) => (
                  <tr key={index} className={`border-t border-zinc-900 ${row.accepted ? '' : 'opacity-50'}`}>
                    <td className="p-2 align-top">
                      <input type="checkbox" checked={row.accepted} onChange={(e) => update(index, { accepted: e.target.checked })} />
                    </td>
                    <td className="p-2 align-top">
                      <input className={input} value={row.name} onChange={(e) => update(index, { name: e.target.value })} />
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                        {row.flagged && (
                          <span className="inline-flex items-center gap-1 text-amber-300">
                            <AlertTriangle className="h-3 w-3" /> low evidence
                          </span>
                        )}
                        {row.status === 'performed' && <span className="text-emerald-300">confirmed performed</span>}
                        {row.sources.some((src) => src.sourceType !== 'user') && (
                          <span className="text-zinc-500">{Math.round(row.confidence * 100)}% confidence</span>
                        )}
                        {row.originalName && row.name !== row.originalName && (
                          <span className="text-violet-300">will remember "{row.originalName}" as "{row.name}"</span>
                        )}
                        {!row.accepted && row.key && (
                          <select
                            className="rounded border border-zinc-800 bg-zinc-900 px-1 text-[11px] text-zinc-300"
                            value={row.rejectReason}
                            onChange={(e) => update(index, { rejectReason: e.target.value as RejectReason })}
                          >
                            <option value="not_an_act">Not an act (stage, sponsor, label)</option>
                            <option value="wrong_event">Wrong event or year</option>
                            <option value="cancelled">Billed but cancelled</option>
                          </select>
                        )}
                      </div>
                    </td>
                    <td className="p-2 align-top">
                      <div className="flex flex-wrap gap-1">
                        {row.sources.length === 0 && <span className="text-[11px] text-zinc-500">Added by you</span>}
                        {row.sources.map((s, i) =>
                          s.sourceUrl ? (
                            <a
                              key={i}
                              href={s.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              title={`"${s.quotedSpan}" via ${s.extractor}`}
                              className="inline-flex items-center gap-0.5 rounded-full border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-violet-500"
                            >
                              {SOURCE_LABELS[s.sourceType]} <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          ) : (
                            <span key={i} className="rounded-full border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
                              {SOURCE_LABELS[s.sourceType]}
                            </span>
                          ),
                        )}
                      </div>
                    </td>
                    <td className="p-2 align-top text-[11px] text-zinc-400">
                      {row.days.join(', ')}
                      {row.stages.length > 0 && <div>{row.stages.join(', ')}</div>}
                    </td>
                    <td className="p-2 align-top">
                      <input type="checkbox" disabled={!row.accepted} checked={row.accepted && row.seen} onChange={(e) => update(index, { seen: e.target.checked })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="p-4 text-sm text-zinc-500">No source listed a lineup. Add the acts you saw below.</p>}
          </div>

          <div className="flex gap-2">
            <input
              className={`${input} max-w-sm`}
              placeholder="Add an act the sources missed"
              value={newAct}
              onChange={(e) => setNewAct(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAct())}
            />
            <button onClick={addAct} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-900">
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-zinc-900 pt-4 sm:grid-cols-6">
          {days.length > 1 && (
            <div className="col-span-2 sm:col-span-6 flex flex-wrap items-center gap-3 text-xs text-zinc-300">
              <span className="font-semibold text-zinc-400">Days you went:</span>
              {days.map((d) => (
                <label key={d} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={attended.length === 0 || attended.includes(d)}
                    onChange={(e) => {
                      const base = attended.length === 0 ? days : attended;
                      setAttended(e.target.checked ? [...base, d] : base.filter((x) => x !== d));
                    }}
                  />
                  {new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </label>
              ))}
            </div>
          )}
          <label className="space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Rating</span>
            <input className={input} type="number" min={1} max={5} value={rating} onChange={(e) => setRating(Number(e.target.value))} />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Ticket price</span>
            <input className={input} type="number" min={0} value={ticketPrice} onChange={(e) => setTicketPrice(e.target.value)} />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Went with (comma separated)</span>
            <input className={input} value={companions} onChange={(e) => setCompanions(e.target.value)} />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-[11px] font-semibold text-zinc-400">Notes</span>
            <input className={input} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>

        <div className="flex items-center justify-end gap-3">
          {error && <p className="mr-auto text-sm text-rose-300">{error}</p>}
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save to archive ({seenCount} seen)
          </button>
        </div>
      </div>
    </div>
  );
};
