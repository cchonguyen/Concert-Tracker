import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Plus, X } from 'lucide-react';
import type { RejectReason } from '../server/lineup/learning';
import { lineupApi, LoggedEvent, LookupJob, SOURCE_LABELS } from '../services/lineupApi';
import { EventTitle } from './EventTitle';
import { filterOptions, groupReviewSlots, startRows } from '../services/reviewRows';
import { readActName } from '../server/lineup/actName';
import { normalizeName } from '../server/lineup/text';
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
  slotId?: string;
  alias?: string;
  b2b?: string[];
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
  b2bDisplay?: string; // who it was billed B2B with
  sources: NonNullable<LookupJob['candidate']>['performers'][number]['sources'];
}

const input =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none';

// Stage 2 review: keep, fix or reject each act and tick who you saw. The
// event's date and place come from the event itself, not from here.
export const LineupReview: React.FC<LineupReviewProps> = ({ job, event, edition, onClose, onSaved }) => {
  const candidate = job.candidate;
  // A role you set on a seen act wins over the sources'.
  const yourSet = new Map(event.seen.filter((s) => s.set).map((s) => [s.key, s.set!]));
  const yourRole = new Map(event.seen.filter((s) => s.roleFrom === 'you').map((s) => [s.key, s.role ?? '']));
  const isRowSeen = (r: { seenKey: string; b2b?: string[] }): boolean => {
    if (r.b2b?.length) {
      return event.seen.some((s) => {
        if (s.key === r.seenKey && s.b2b?.length && s.b2b.some((k) => r.b2b!.includes(k))) return true;
        const parts = readActName(s.name).parts.map(normalizeName);
        return parts.length > 1 && parts.includes(r.seenKey) && r.b2b!.some((k) => parts.includes(k));
      });
    }
    return event.seen.some((s) => s.key === r.seenKey && (!s.b2b?.length || s.solo));
  };

  const [rows, setRows] = useState<Row[]>(
    startRows(candidate?.performers ?? [], edition).map((r) => ({
      key: r.key,
      slotId: r.slotId,
      alias: r.alias,
      b2b: r.b2b,
      name: r.name,
      originalName: r.candidate?.name,
      accepted: r.accepted,
      rejectReason: r.cancelled ? 'cancelled' : 'not_an_act',
      seen: isRowSeen(r),
      billing: (yourRole.get(r.seenKey) ?? r.billing ?? '') as Row['billing'],
      days: r.days,
      stages: r.stages,
      confidence: r.candidate?.confidence ?? 1,
      flagged: r.candidate?.flagged ?? false,
      missingFrom: (r.candidate?.missingFrom ?? []).map((t) => SOURCE_LABELS[t]),
      status: r.candidate?.status === 'performed' ? 'performed' : 'billed',
      sources: r.candidate?.sources ?? [],
      set: yourSet.get(r.seenKey) ?? r.candidate?.set ?? '',
      b2bDisplay: r.candidate?.b2b?.map((k) => candidate?.performers.find((p) => p.key === k)?.name ?? k).join(', '),
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

  const slots = groupReviewSlots(rows);
  const visible = slots.filter(
    (slot) =>
      (!onlyFlagged || slot.flagged) &&
      (!day || slot.days.includes(day)) &&
      (!stage || slot.stages.includes(stage)) &&
      (slot.name.toLowerCase().includes(filter.toLowerCase()) ||
        slot.items.some((it) => it.item.name.toLowerCase().includes(filter.toLowerCase()))),
  );

  const update = (index: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const setAll = (patch: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r, i) =>
        visible.some((slot) => slot.items.some((it) => it.index === i)) ? { ...r, ...patch } : r,
      ),
    );

  const splitRowIfB2b = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const read = readActName(row.name);
    if (read.parts.length <= 1) return;
    const allKeys = read.parts.map(normalizeName).filter(Boolean);
    if (allKeys.length <= 1) return;
    const slotId = row.slotId || crypto.randomUUID();
    const replacementRows: Row[] = read.parts.map((part) => {
      const key = normalizeName(part);
      return {
        ...row,
        key,
        name: part,
        slotId,
        b2b: allKeys.filter((k) => k !== key),
        originalName: undefined,
        set: read.dj ? 'dj' : row.set,
      };
    });
    setRows((rs) => [...rs.slice(0, index), ...replacementRows, ...rs.slice(index + 1)]);
  };

  const addAct = () => {
    const name = newAct.trim();
    if (!name) return;
    const read = readActName(name);
    if (read.parts.length > 1) {
      const slotId = crypto.randomUUID();
      const allKeys = read.parts.map(normalizeName).filter(Boolean);
      const newRows: Row[] = read.parts.map((part) => {
        const key = normalizeName(part);
        return {
          key,
          slotId,
          b2b: allKeys.filter((k) => k !== key),
          name: part,
          accepted: true,
          rejectReason: 'not_an_act',
          seen: true,
          billing: '',
          set: read.dj ? 'dj' : '',
          days: [],
          stages: [],
          confidence: 1,
          flagged: false,
          missingFrom: [],
          status: 'billed',
          sources: [],
        };
      });
      setRows((rs) => [...rs, ...newRows]);
    } else {
      setRows((rs) => [
        ...rs,
        {
          name,
          accepted: true,
          rejectReason: 'not_an_act',
          seen: true,
          billing: '',
          set: read.dj ? 'dj' : '',
          days: [],
          stages: [],
          confidence: 1,
          flagged: false,
          missingFrom: [],
          status: 'billed',
          sources: [],
        },
      ]);
    }
    setNewAct('');
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const expandedRows = rows.flatMap((r) => {
        if (r.b2b?.length) return [r];
        const read = readActName(r.name);
        if (read.parts.length <= 1) return [r];
        const allKeys = read.parts.map(normalizeName).filter(Boolean);
        if (allKeys.length <= 1) return [r];
        const slotId = r.slotId || crypto.randomUUID();
        return read.parts.map((part) => {
          const key = normalizeName(part);
          return {
            ...r,
            key,
            name: part,
            slotId,
            b2b: allKeys.filter((k) => k !== key),
          };
        });
      });

      const { event: updated } = await lineupApi.confirm(job.id, {
        performers: expandedRows.map((r) => ({
          key: r.key,
          slotId: r.slotId,
          alias: r.alias,
          b2b: r.b2b,
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
            <input aria-label="Filter acts" className={`${input} max-w-xs`} placeholder="Filter acts" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
                {visible.map((slot) => {
                  const allAccepted = slot.items.every((it) => it.item.accepted);
                  const allSeen = slot.items.every((it) => it.item.accepted && it.item.seen);
                  const anyAccepted = slot.items.some((it) => it.item.accepted);
                  const allSources = slot.items.flatMap((it) => it.item.sources);
                  const uniqueSources = allSources.filter(
                    (s, idx, arr) => arr.findIndex((o) => o.sourceType === s.sourceType && o.sourceUrl === s.sourceUrl) === idx,
                  );
                  const allMissingFrom = [...new Set(slot.items.flatMap((it) => it.item.missingFrom))];
                  const renamedItems = slot.items.filter((it) => it.item.originalName && it.item.name !== it.item.originalName);

                  return (
                    <tr key={slot.id} className={`border-t border-zinc-900 ${allAccepted ? '' : 'opacity-50'}`}>
                      <td className="p-2 align-top">
                        <input
                          type="checkbox"
                          checked={allAccepted}
                          onChange={(e) => {
                            const accepted = e.target.checked;
                            slot.items.forEach((it) => update(it.index, { accepted }));
                          }}
                        />
                      </td>
                      <td className="p-2 align-top">
                        {slot.items.length === 1 ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              className={input}
                              value={slot.items[0].item.name}
                              onChange={(e) => update(slot.items[0].index, { name: e.target.value })}
                              onBlur={() => splitRowIfB2b(slot.items[0].index)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  splitRowIfB2b(slot.items[0].index);
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs font-medium text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                              title="Make B2B: pairs this act with another artist"
                              onClick={() => {
                                const idx = slot.items[0].index;
                                update(idx, { name: `${slot.items[0].item.name} b2b ` });
                              }}
                            >
                              + B2B
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-zinc-100">{slot.name}</span>
                              <button
                                type="button"
                                className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                                title="Add another partner to this set (B3B/B4B)"
                                onClick={() => {
                                  const slotId = slot.items[0].item.slotId || crypto.randomUUID();
                                  const newPartner: Row = {
                                    slotId,
                                    name: '',
                                    accepted: true,
                                    rejectReason: 'not_an_act',
                                    seen: slot.items.some((it) => it.item.seen),
                                    billing: '',
                                    set: '',
                                    days: slot.days,
                                    stages: slot.stages,
                                    confidence: 1,
                                    flagged: false,
                                    missingFrom: [],
                                    status: 'billed',
                                    sources: [],
                                  };
                                  setRows((rs) => [...rs, newPartner]);
                                }}
                              >
                                + Partner
                              </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {slot.items.map((it) => (
                                <input
                                  key={it.index}
                                  className={`${input} max-w-[150px] py-0.5 text-xs`}
                                  value={it.item.name}
                                  onChange={(e) => update(it.index, { name: e.target.value })}
                                  onBlur={() => splitRowIfB2b(it.index)}
                                  placeholder="Artist name"
                                  title={`Edit name for ${it.item.name}`}
                                  aria-label={`Name for ${it.item.name}`}
                                />
                              ))}
                              <input
                                className={`${input} max-w-[150px] py-0.5 text-xs text-sky-300 placeholder:text-zinc-600`}
                                placeholder="AKA (e.g. Subjohnics)"
                                value={slot.items[0].item.alias ?? ''}
                                onChange={(e) => {
                                  const alias = e.target.value.trim() || undefined;
                                  slot.items.forEach((it) => update(it.index, { alias }));
                                }}
                                title="Set collaborative project moniker (AKA)"
                                aria-label="Collaboration Alias"
                              />
                            </div>
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                          {slot.flagged && (
                            <span className="inline-flex items-center gap-1 text-amber-300">
                              <AlertTriangle className="h-3 w-3" /> low evidence
                            </span>
                          )}
                          {slot.status === 'performed' && <span className="text-emerald-300">confirmed performed</span>}
                          {slot.isB2b && <span className="text-sky-300">B2B set</span>}
                          {uniqueSources.some((src) => src.sourceType !== 'user') && (
                            <span
                              className="text-zinc-400"
                              title="Sources that list the act, weighted by how often each has been right in your reviews; a full lineup that leaves it out lowers it."
                            >
                              {Math.round(slot.confidence * 100)}% confidence
                            </span>
                          )}
                          {allMissingFrom.length > 0 && (
                            <span className="text-amber-300/80">not on {allMissingFrom.join(' or ')} lineup</span>
                          )}
                          {renamedItems.map((it) => (
                            <span key={it.index} className="text-violet-300">
                              will remember "{it.item.originalName}" as "{it.item.name}"
                            </span>
                          ))}
                          {!allAccepted && slot.items.some((it) => it.item.key) && (
                            <select
                              className="rounded border border-zinc-800 bg-zinc-900 px-1 text-[11px] text-zinc-300"
                              value={slot.items[0].item.rejectReason}
                              onChange={(e) => {
                                const rejectReason = e.target.value as RejectReason;
                                slot.items.forEach((it) => update(it.index, { rejectReason }));
                              }}
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
                          {uniqueSources.length === 0 && <span className="text-[11px] text-zinc-400">Added by you</span>}
                          {uniqueSources.map((s, i) =>
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
                          value={slot.items[0].item.billing}
                          onChange={(e) => {
                            const billing = e.target.value as Row['billing'];
                            slot.items.forEach((it) => update(it.index, { billing }));
                          }}
                          title="Artist: headliner, or no lead stated. Supporting: billed as support."
                        >
                          <option value="">Artist</option>
                          <option value="headliner">Headliner</option>
                          <option value="support">Supporting</option>
                        </select>
                        <select
                          className="mt-1 block rounded border border-zinc-800 bg-zinc-900 px-1 py-1 text-xs text-zinc-200"
                          value={slot.items[0].item.set}
                          onChange={(e) => {
                            const set = e.target.value as Row['set'];
                            slot.items.forEach((it) => update(it.index, { set }));
                          }}
                          aria-label={`Set type for ${slot.name}`}
                        >
                          <option value="">Set type</option>
                          <option value="dj">DJ set</option>
                          <option value="live">Live set</option>
                        </select>
                      </td>
                      <td className="p-2 align-top text-[11px] text-zinc-400">
                        {slot.days.join(', ')}
                        {slot.stages.length > 0 && <div>{slot.stages.join(', ')}</div>}
                      </td>
                      <td className="p-2 align-top">
                        <input
                          type="checkbox"
                          disabled={!anyAccepted}
                          checked={allSeen}
                          onChange={(e) => {
                            const seen = e.target.checked;
                            slot.items.forEach((it) => update(it.index, { seen }));
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="p-4 text-sm text-zinc-400">No source listed a lineup. Add the acts you saw below.</p>}
          </div>

          <div className="flex gap-2">
            <input aria-label="Add an act the sources missed"
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
