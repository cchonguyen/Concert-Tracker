import React, { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Plus, X } from 'lucide-react';
import type { RejectReason } from '../server/lineup/learning';
import { lineupApi, collaborationsApi, type CollaborationItem, LoggedEvent, LookupJob, SOURCE_LABELS } from '../services/lineupApi';
import { EventTitle } from './EventTitle';
import { filterOptions, groupReviewSlots, pendingReplacement, startRows, type ReviewSubject } from '../services/reviewRows';
import { hasUnambiguousB2bMark, readActName } from '../server/lineup/actName';
import { normalizeName } from '../server/lineup/text';
import { normalizeSet } from '../server/events/seen';
import type { Edition } from '../server/lineup/types';
import type { CanonicalConfirmInput, CanonicalDiff } from '../server/lineup/canonicalIngest';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { Pill } from './ui/Pill';
import { SuggestInput } from './SuggestInput';

interface LineupReviewProps {
  job: ReviewSubject; // a lookup's job, or a saved edition (reviewSubjectFromEdition)
  event?: LoggedEvent; // undefined in canonical mode (no saved event)
  // personal: your log (the default with an event). canonical: the shared catalog (owner only).
  mode?: 'personal' | 'canonical';
  onClose: () => void;
  onSaved: (event?: LoggedEvent) => void;
  edition?: Edition | null; // set when reopening a confirmed lineup
}

interface Row {
  key?: string;
  slotId?: string;
  alias?: string;
  b2b?: string[];
  name: string;
  oneAct?: boolean; // you kept this name as one act: never split on blur or save
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
  set: string; // yours, or as the lineup billed it
  b2bDisplay?: string; // who it was billed B2B with
  sources: NonNullable<LookupJob['candidate']>['performers'][number]['sources'];
}

const input =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none';

// Stage 2 review: keep, fix or reject each act and tick who you saw. The
// event's date and place come from the event itself, not from here.
export const LineupReview: React.FC<LineupReviewProps> = ({ job, event, mode, edition, onClose, onSaved }) => {
  const canonical = (mode ?? (event ? 'personal' : 'canonical')) === 'canonical';
  const seenSource = event?.seen ?? [];
  const candidate = job.candidate;
  const replacing = !canonical && pendingReplacement(job, edition);
  // A role you set on a seen act wins over the sources'.
  const yourSet = new Map(seenSource.filter((s) => s.set).map((s) => [s.key, s.set!]));
  const yourRole = new Map(seenSource.filter((s) => s.roleFrom === 'you').map((s) => [s.key, s.role ?? '']));
  const isRowSeen = (r: { seenKey: string; b2b?: string[] }): boolean => {
    if (r.b2b?.length) {
      return seenSource.some((s) => {
        if (s.key === r.seenKey && s.b2b?.length && s.b2b.some((k) => r.b2b!.includes(k))) return true;
        const parts = readActName(s.name).parts.map(normalizeName);
        return parts.length > 1 && parts.includes(r.seenKey) && r.b2b!.some((k) => parts.includes(k));
      });
    }
    return seenSource.some((s) => s.key === r.seenKey && (!s.b2b?.length || s.solo));
  };

  const [rows, setRows] = useState<Row[]>(
    startRows(candidate?.performers ?? [], edition, { replacing }).map((r) => {
      const rawSet = yourSet.get(r.seenKey) ?? r.set ?? r.candidate?.set ?? '';
      return {
        key: r.key,
        slotId: r.slotId,
        alias: r.alias,
        b2b: r.b2b,
        name: r.name,
        oneAct: r.oneAct,
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
        set: normalizeSet(rawSet) ?? rawSet ?? '',
        b2bDisplay: r.candidate?.b2b?.map((k) => candidate?.performers.find((p) => p.key === k)?.name ?? k).join(', '),
      };
    }),
  );
  const options = filterOptions(rows);
  const [day, setDay] = useState('');
  const [stage, setStage] = useState('');
  const [filter, setFilter] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [newAct, setNewAct] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Canonical save shows the merge diff first. The preview is kept with the request it was made for.
  const [preview, setPreview] = useState<{ key: string; diff: CanonicalDiff } | null>(null);

  const setSuggestions = useMemo(() => {
    const common = ['DJ Set', 'Live'];
    const fromRows = rows.map((r) => r.set.trim()).filter((s) => s && !common.includes(s));
    return [...common, ...new Set(fromRows)];
  }, [rows]);

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

  const [collabs, setCollabs] = useState<CollaborationItem[]>([]);
  useEffect(() => {
    collaborationsApi.list().then(setCollabs).catch(() => undefined);
  }, []);

  const collabSuggestions = useMemo(() => collabs.map((c) => c.alias), [collabs]);

  const removePartnerFromSlot = (slotId: string, itemIndexToRemove: number) => {
    setRows((rs) => {
      const remainingItems = rs.filter((r, idx) => r.slotId === slotId && idx !== itemIndexToRemove);
      const removedKey = rs[itemIndexToRemove]?.key || normalizeName(rs[itemIndexToRemove]?.name || '');

      return rs
        .filter((_, idx) => idx !== itemIndexToRemove)
        .map((r) => {
          if (r.slotId === slotId) {
            if (remainingItems.length === 1) {
              // Revert to solo act
              const { slotId: _s, alias: _a, b2b: _b, ...rest } = r;
              return rest;
            }
            return {
              ...r,
              b2b: r.b2b?.filter((k) => k !== removedKey),
            };
          }
          return r;
        });
    });
  };

  // Typing a name into a row with no B2B partners keeps it as one act unless the
  // text carries an unambiguous B2B mark ("b2b", "vs"); \" X \" alone stays one act.
  const typeName = (index: number, value: string) => {
    const row = rows[index];
    const keepWhole = !row?.b2b?.length && !hasUnambiguousB2bMark(value);
    update(index, { name: value, oneAct: keepWhole ? true : undefined });
  };

  const splitRowIfB2b = (index: number) => {
    const row = rows[index];
    if (!row) return;

    // Check if name matches a known collaboration
    const matchingCollab = collabs.find((c) => normalizeName(c.alias) === normalizeName(row.name));
    if (matchingCollab) {
      const slotId = row.slotId || crypto.randomUUID();
      const allKeys = matchingCollab.partners.map(normalizeName).filter(Boolean);
      const replacementRows: Row[] = matchingCollab.partners.map((part) => {
        const key = normalizeName(part);
        return {
          ...row,
          key,
          slotId,
          alias: matchingCollab.alias,
          b2b: allKeys.filter((k) => k !== key),
          name: part,
          originalName: undefined,
        };
      });
      setRows((rs) => [...rs.slice(0, index), ...replacementRows, ...rs.slice(index + 1)]);
      return;
    }

    const read = readActName(row.name);
    if (read.parts.length === 1 && read.set) {
      update(index, {
        name: read.parts[0],
        set: read.set || row.set,
      });
      return;
    }
    if (read.parts.length <= 1) return;
    if (row.oneAct) return; // kept whole by you: the set suffix above still applies
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
        set: read.set || row.set,
      };
    });
    setRows((rs) => [...rs.slice(0, index), ...replacementRows, ...rs.slice(index + 1)]);
  };

  const addAct = () => {
    const name = newAct.trim();
    if (!name) return;

    const matchingCollab = collabs.find((c) => normalizeName(c.alias) === normalizeName(name));
    if (matchingCollab) {
      const slotId = crypto.randomUUID();
      const allKeys = matchingCollab.partners.map(normalizeName).filter(Boolean);
      const newRows: Row[] = matchingCollab.partners.map((part) => {
        const key = normalizeName(part);
        return {
          key,
          slotId,
          alias: matchingCollab.alias,
          b2b: allKeys.filter((k) => k !== key),
          name: part,
          accepted: true,
          rejectReason: 'not_an_act',
          seen: true,
          billing: '',
          set: '',
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
      setNewAct('');
      return;
    }

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
          set: read.set || '',
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
          name: read.parts[0] || name,
          accepted: true,
          rejectReason: 'not_an_act',
          seen: true,
          billing: '',
          set: read.set || '',
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

  // The acts as the review leaves them, with brackets expanded for B2B names.
  const expandRows = () =>
    rows.flatMap((r) => {
      if (r.b2b?.length || r.oneAct) return [r];
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

  // The canonical request. Preview and save send the same one, so the diff shown is the diff saved.
  const canonicalRequest = (): CanonicalConfirmInput => ({
    ...(edition?.id ? { editionId: edition.id } : {}),
    jobId: job.id,
    name: job.input.eventName,
    year: job.input.year,
    startDate: job.input.startDate,
    endDate: job.input.endDate,
    venue: job.input.venue,
    city: job.input.city,
    country: job.input.country,
    performers: expandRows().map((r) => ({
      name: r.name,
      ...(r.oneAct ? { oneAct: true } : {}),
      accepted: r.accepted,
      billing: (r.billing || undefined) as 'headliner' | 'support' | undefined,
      days: r.days,
      stages: r.stages,
      set: r.set || undefined,
    })),
  });

  const previewCanonical = async () => {
    setError(null);
    setSaving(true);
    try {
      const request = canonicalRequest();
      const result = await lineupApi.canonicalConfirm({ ...request, apply: false });
      setPreview({ key: JSON.stringify(request), diff: result.diff as CanonicalDiff });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (canonical) {
      const request = canonicalRequest();
      // First press shows the diff; the second press (with the same acts) saves.
      if (!preview || preview.key !== JSON.stringify(request)) return previewCanonical();
      setError(null);
      setSaving(true);
      try {
        await lineupApi.canonicalConfirm({ ...request, apply: true });
        onSaved(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const { event: updated } = await lineupApi.confirm(job.id, {
        performers: expandRows().map((r) => ({
          key: r.key,
          slotId: r.slotId,
          alias: r.alias,
          b2b: r.b2b,
          name: r.name,
          ...(r.oneAct ? { oneAct: true } : {}),
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

  const previewed = canonical && preview !== null && preview.key === JSON.stringify(canonicalRequest());

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
            <h2 className="text-lg font-bold text-zinc-50">{canonical ? 'Lineup for ' : 'Who played '}{event ? <EventTitle event={event} /> : `${job.input.eventName} ${job.input.year}`}</h2>
            <p className="text-xs text-zinc-400">
              {replacing
                ? 'The version you chose. Saving replaces your confirmed lineup; your spellings, roles and who you saw are kept. Acts only the old lineup had start unticked.'
                : edition
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
            {!canonical && (
              <>
                <button className="text-zinc-300 hover:underline" onClick={() => setAll({ seen: true })}>Saw all shown</button>
                <button className="text-zinc-300 hover:underline" onClick={() => setAll({ seen: false })}>Saw none shown</button>
              </>
            )}
            <span className="ml-auto text-zinc-400">
              {rows.filter((r) => r.accepted).length} accepted{!canonical && ` · ${seenCount} seen`}
            </span>
          </div>

          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-900 text-left text-[11px] uppercase text-zinc-400">
                <tr>
                  <th className="p-2">Keep</th>
                  <th className="p-2">Act</th>
                  <th className="p-2">Sources</th>
                  <th className="p-2">Role</th>
                  <th className="p-2">Set</th>
                  <th className="p-2">Day / stage</th>
                  {!canonical && <th className="p-2">Saw it</th>}
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
                  const renamedItems = slot.items.filter((it) => {
                    const orig = it.item.originalName;
                    if (!orig || it.item.name === orig) return false;
                    const origKey = normalizeName(orig);
                    return !slot.items.some((other) => other.index !== it.index && normalizeName(other.item.name) === origKey);
                  });

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
                              onChange={(e) => typeName(slot.items[0].index, e.target.value)}
                              onBlur={() => splitRowIfB2b(slot.items[0].index)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  splitRowIfB2b(slot.items[0].index);
                                }
                              }}
                            />
                            <Button
                              variant="secondary"
                              className="shrink-0 text-xs py-1 px-2 h-auto text-zinc-400 hover:text-zinc-200"
                              title="Make B2B: pairs this act with another artist"
                              onClick={() => {
                                const idx = slot.items[0].index;
                                update(idx, { name: `${slot.items[0].item.name} b2b ` });
                              }}
                            >
                              + B2B
                            </Button>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-zinc-100">{slot.name}</span>
                              {slot.alias && <Pill tone="accent">{slot.alias}</Pill>}
                              <Button
                                variant="secondary"
                                className="text-xs py-0.5 px-2 h-auto text-zinc-400 hover:text-zinc-200"
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
                              </Button>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {slot.items.map((it) => (
                                <div
                                  key={it.index}
                                  className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/90 px-1.5 py-0.5"
                                >
                                  <input
                                    className="bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none max-w-[120px]"
                                    value={it.item.name}
                                    onChange={(e) => typeName(it.index, e.target.value)}
                                    onBlur={() => splitRowIfB2b(it.index)}
                                    placeholder="Artist name"
                                    title={`Edit name for ${it.item.name}`}
                                    aria-label={`Name for ${it.item.name}`}
                                  />
                                  <IconButton
                                    icon={X}
                                    label={`Remove ${it.item.name || 'partner'} from set`}
                                    size="chip"
                                    onClick={() => removePartnerFromSlot(slot.id, it.index)}
                                  />
                                </div>
                              ))}
                              <SuggestInput
                                value={slot.items[0].item.alias ?? ''}
                                suggestions={collabSuggestions}
                                onPick={(pickedAlias) => {
                                  const matching = collabs.find((c) => normalizeName(c.alias) === normalizeName(pickedAlias));
                                  const val = matching?.alias ?? pickedAlias;
                                  slot.items.forEach((it) => update(it.index, { alias: val }));
                                }}
                                onChange={(e) => {
                                  const alias = e.target.value.trim() || undefined;
                                  slot.items.forEach((it) => update(it.index, { alias }));
                                }}
                                placeholder="AKA (e.g. Subjohnics)"
                                className={`${input} max-w-[150px] py-0.5 text-xs text-sky-300 placeholder:text-zinc-600`}
                                title="Set collaborative project moniker (AKA)"
                                aria-label="Collaboration Alias"
                              />
                            </div>
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                          {slot.flagged && (
                            <Pill tone="warn">
                              <AlertTriangle className="h-3 w-3" /> low evidence
                            </Pill>
                          )}
                          {slot.status === 'performed' && <Pill tone="good">confirmed performed</Pill>}
                          {slot.isB2b && <Pill tone="info">{slot.items.length > 2 ? `B${slot.items.length}B set` : 'B2B set'}</Pill>}
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
                          aria-label={`Role for ${slot.name}`}
                        >
                          <option value="">Artist</option>
                          <option value="headliner">Headliner</option>
                          <option value="support">Supporting</option>
                        </select>
                      </td>
                      <td className="p-2 align-top min-w-[130px] max-w-[180px]">
                        <SuggestInput
                          value={slot.items[0].item.set ?? ''}
                          suggestions={setSuggestions}
                          onPick={(pickedSet) => {
                            const trimmed = pickedSet.trim();
                            slot.items.forEach((it) => update(it.index, { set: trimmed }));
                          }}
                          onChange={(e) => {
                            const set = e.target.value;
                            slot.items.forEach((it) => update(it.index, { set }));
                          }}
                          onBlur={(e) => {
                            const trimmed = e.target.value.trim();
                            slot.items.forEach((it) => update(it.index, { set: trimmed }));
                          }}
                          placeholder="Set type"
                          className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
                          aria-label={`Set for ${slot.name}`}
                        />
                      </td>
                      <td className="p-2 align-top text-[11px] text-zinc-400">
                        {slot.days.join(', ')}
                        {slot.stages.length > 0 && <div>{slot.stages.join(', ')}</div>}
                      </td>
                      {!canonical && (
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
                      )}
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

        {canonical && preview && <CanonicalDiffPanel diff={preview.diff} stale={!previewed} />}
        <div className="flex items-center justify-end gap-3">
          {error && <p className="mr-auto text-sm text-rose-300">{error}</p>}
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {canonical
              ? previewed
                ? 'Confirm and save edition'
                : `Review changes (${rows.filter((r) => r.accepted).length} billed acts)`
              : `Save lineup (${seenCount} seen)`}
          </button>
        </div>
      </div>
    </div>
  );
};

const FACT_LABEL: Record<string, string> = {
  name: 'Name',
  startDate: 'Start date',
  endDate: 'End date',
  venue: 'Venue',
  city: 'City',
  country: 'Country',
};

// What saving will change in the archive, shown before the save (the server's preview).
const CanonicalDiffPanel: React.FC<{ diff: CanonicalDiff; stale: boolean }> = ({ diff, stale }) => (
  <section aria-label="Changes to save" className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
    <h3 className="font-semibold text-zinc-100">Changes to save</h3>
    {stale && <p className="text-amber-300">The acts changed since this preview. Review changes again before saving.</p>}
    <ul className="space-y-1 text-zinc-300">
      <li>Added ({diff.added.length}): {diff.added.length ? diff.added.join(', ') : 'none'}</li>
      <li>Changed ({diff.changed.length}): {diff.changed.length ? `${diff.changed.join(', ')}, set, days, stages or role replaced` : 'none'}</li>
      <li>Unchanged ({diff.unchanged.length}): {diff.unchanged.length ? diff.unchanged.join(', ') : 'none'}</li>
      {diff.filledFacts.length > 0 && (
        <li>Blank details filled: {diff.filledFacts.map((f) => FACT_LABEL[f] ?? f).join(', ')}</li>
      )}
      {diff.factConflicts.map((c) => (
        <li key={c.field}>
          {FACT_LABEL[c.field] ?? c.field}: kept "{c.stored}", not replaced with "{c.sent}"
        </li>
      ))}
    </ul>
    <p className="text-xs text-zinc-500">Acts you untick are not removed from the archive; they stay as stored.</p>
  </section>
);
