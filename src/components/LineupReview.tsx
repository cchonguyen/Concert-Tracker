import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Plus, X } from 'lucide-react';
import type { RejectReason } from '../server/lineup/learning';
import { lineupApi, LoggedEvent, LookupJob, SOURCE_LABELS } from '../services/lineupApi';
import { EventTitle } from './EventTitle';
import { filterOptions, startRows } from '../services/reviewRows';
import type { Edition } from '../server/lineup/types';

interface LineupReviewProps {
  job: LookupJob;
  event: LoggedEvent;
  onClose: () => void;
  onSaved: (event: LoggedEvent) => void;
  edition?: Edition | null; // set when reopening a confirmed lineup
}

interface Row {
  key?: string;
  name: string;
  originalName?: string;
  accepted: boolean;
  rejectReason: RejectReason;
  seen: boolean;
  billing: '' | 'headliner' | 'support'; // '' : no lead stated (Artist)
  days: string[];
  stages: string[];
  confidence: number;
  flagged: boolean;
  missingFrom: string[];
  status: 'billed' | 'performed';
  set: '' | 'dj' | 'live'; // yours, or as the lineup billed it
  b2b?: string; // who it was billed B2B with
  sources: NonNullable<LookupJob['candidate']>['performers'][number]['sources'];
}

const input =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none';

// Stage 2 review: keep, fix or reject each act and tick who you saw. The
// event's date and place come from the event itself, not from here.
export const LineupReview: React.FC<LineupReviewProps> = ({ job, event, edition, onClose, onSaved }) => {
  const candidate = job.candidate;
  const alreadySeen = new Set(event.seen.map((s) => s.key));
  // A role you set on a seen act wins over the sources'.
  const yourSet = new Map(event.seen.filter((s) => s.set).map((s) => [s.key, s.set!]));
  const yourRole = new Map(event.seen.filter((s) => s.roleFrom === 'you').map((s) => [s.key, s.role ?? '']));
  const [rows, setRows] = useState<Row[]>(
    startRows(candidate?.performers ?? [], edition).map((r) => ({
      key: r.key,
      name: r.name,
      originalName: r.candidate?.name,
      accepted: r.accepted,
      rejectReason: r.cancelled ? 'cancelled' : 'not_an_act',
      seen: alreadySeen.has(r.seenKey),
      billing: (yourRole.get(r.seenKey) ?? r.billing ?? '') as Row['billing'],
      days: r.days,
      stages: r.stages,
      confidence: r.candidate?.confidence ?? 1,
      flagged: r.candidate?.flagged ?? false,
      missingFrom: (r.candidate?.missingFrom ?? []).map((t) => SOURCE_LABELS[t]),
      status: r.candidate?.status === 'performed' ? 'performed' : 'billed',
      sources: r.candidate?.sources ?? [],
      set: yourSet.get(r.seenKey) ?? r.candidate?.set ?? '',
      b2b: r.candidate?.b2b?.map((k) => candidate?.performers.find((p) => p.key === k)?.name ?? k).join(', '),
    })),
  );
  const options = filterOptions(rows);
  const [day, setDay] = useState('');
  const [stage, setStage] = useState('');
  const [filter, setFilter] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [newAct, setNewAct] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (!onlyFlagged || row.flagged) && (!day || row.days.includes(day)) && (!stage || row.stages.includes(stage)) && row.name.toLowerCase().includes(filter.toLowerCase()));

  const update = (index: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const setAll = (patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (visible.some((v) => v.index === i) ? { ...r, ...patch } : r)));

  const addAct = () => {
    const name = newAct.trim();
    if (!name) return;
    setRows((rs) => [
      ...rs,
      { name, accepted: true, rejectReason: 'not_an_act', seen: true, billing: '', set: '', days: [], stages: [], confidence: 1, flagged: false, missingFrom: [], status: 'billed', sources: [] },
    ]);
    setNewAct('');
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const { event: updated } = await lineupApi.confirm(job.id, {
        performers: rows.map((r) => ({
          key: r.key,
          name: r.name,
          accepted: r.accepted,
          rejectReason: r.accepted ? undefined : r.rejectReason,
          seen: r.accepted && r.seen,
          billing: r.billing || null,
          set: r.set || null,
          days: r.days,
          stages: r.stages,
        })),
      });
      onSaved(updated ?? event);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const seenCount = rows.filter((r) => r.accepted && r.seen).length;

  return (
    // Rendered inside the event panel's backdrop, whose click closes the panel:
    // keep clicks in here (ticking a box) from reaching it.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-5xl space-y-5 rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-zinc-50">Who played <EventTitle event={event} /></h2>
            <p className="text-xs text-zinc-400">
              {edition
                ? 'Your saved lineup. Change anything and save again.'
                : candidate?.cached
                ? 'This edition was confirmed before, so it came straight from your database.'
                : 'Every act below was found on at least one source page. Untick anything wrong, fix spellings, and tick who you saw. Your fixes are remembered for next time.'}
              {candidate?.droppedCount ? ` ${candidate.droppedCount} entries were filtered out by your earlier corrections.` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input className={`${input} max-w-xs`} placeholder="Filter acts" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="inline-flex items-center gap-1 text-zinc-400">
              <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Low evidence only
            </label>
            {options.days.length > 0 && (
              <select className={`${input} w-auto`} value={day} onChange={(e) => setDay(e.target.value)} aria-label="Filter by day">
                <option value="">Every day</option>
                {options.days.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            )}
            {options.stages.length > 0 && (
              <select className={`${input} w-auto`} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
                <option value="">Every stage</option>
                {options.stages.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            )}
            <span className="mx-1 text-zinc-700">|</span>
            <button className="text-zinc-300 hover:underline" onClick={() => setAll({ accepted: true })}>Accept shown</button>
            <button className="text-zinc-300 hover:underline" onClick={() => setAll({ seen: true })}>Saw all shown</button>
            <button className="text-zinc-300 hover:underline" onClick={() => setAll({ seen: false })}>Saw none shown</button>
            <span className="ml-auto text-zinc-400">
              {rows.filter((r) => r.accepted).length} accepted · {seenCount} seen
            </span>
          </div>

          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-900 text-left text-[11px] uppercase text-zinc-400">
                <tr>
                  <th className="p-2">Keep</th>
                  <th className="p-2">Act</th>
                  <th className="p-2">Sources</th>
                  <th className="p-2">Billed as</th>
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
                        {row.b2b && <span className="text-sky-300">b2b {row.b2b}</span>}
                        {row.sources.some((src) => src.sourceType !== 'user') && (
                          <span
                            className="text-zinc-400"
                            title="Sources that list the act, weighted by how often each has been right in your reviews; a full lineup that leaves it out lowers it."
                          >
                            {Math.round(row.confidence * 100)}% confidence
                          </span>
                        )}
                        {row.missingFrom.length > 0 && (
                          <span className="text-amber-300/80">not on {row.missingFrom.join(' or ')} lineup</span>
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
                        {row.sources.length === 0 && <span className="text-[11px] text-zinc-400">Added by you</span>}
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
                    <td className="p-2 align-top">
                      <select
                        className="rounded border border-zinc-800 bg-zinc-900 px-1 py-1 text-xs text-zinc-200"
                        value={row.billing}
                        onChange={(e) => update(index, { billing: e.target.value as Row['billing'] })}
                        title="Artist: headliner, or no lead stated. Supporting: billed as support."
                      >
                        <option value="">Artist</option>
                        <option value="headliner">Headliner</option>
                        <option value="support">Supporting</option>
                      </select>
                      <select
                        className="mt-1 block rounded border border-zinc-800 bg-zinc-900 px-1 py-1 text-xs text-zinc-200"
                        value={row.set}
                        onChange={(e) => update(index, { set: e.target.value as Row['set'] })}
                        aria-label={`Set type for ${row.name}`}
                      >
                        <option value="">Set type</option>
                        <option value="dj">DJ set</option>
                        <option value="live">Live set</option>
                      </select>
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
            {rows.length === 0 && <p className="p-4 text-sm text-zinc-400">No source listed a lineup. Add the acts you saw below.</p>}
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

        <div className="flex items-center justify-end gap-3">
          {error && <p className="mr-auto text-sm text-rose-300">{error}</p>}
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save lineup ({seenCount} seen)
          </button>
        </div>
      </div>
    </div>
  );
};
