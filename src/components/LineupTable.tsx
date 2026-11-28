import React, { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { EditionPerformance, SetTime } from '../server/lineup/types';
import type { InferredBilling } from '../server/canon/inferredBilling';
import { actSets, byStartTime } from '../server/events/sets';
import { toSeenInput } from '../server/events/seen';
import { whenLabel } from '../services/format';
import type { EventPatch, LoggedEvent } from '../services/lineupApi';
import { groupReviewSlots } from '../services/reviewRows';
import { Pill } from './ui/Pill';
import { Popover } from './ui/Popover';
import { Segmented } from './ui/Segmented';
import { Tabs } from './ui/Tabs';

type SeenPatch = NonNullable<EventPatch['seen']>;

const clock = (t?: string) => t?.match(/[ T](\d{2}:\d{2})/)?.[1];

const InferredRole: React.FC<{ inferred: InferredBilling }> = ({ inferred }) => {
  const reason = inferred.reason.replace(/[.\s]+$/, '');
  return (
    <Popover label="Why this role is inferred" content={<p className="max-w-xs text-xs leading-relaxed text-text">{`Inferred: ${reason}.`}</p>}>
      <button type="button" aria-label="Why this role is inferred" className="rounded-full">
        <Pill tone="inferred">{inferred.role === 'headliner' ? 'Inferred headliner' : 'Inferred support'}</Pill>
      </button>
    </Popover>
  );
};

interface LineupTableProps {
  lineupActs: EditionPerformance[];
  seen: LoggedEvent['seen'];
  sets: Map<string, string>;
  starts: Map<string, string>;
  daysAttended?: string[];
  inferredBilling: Record<string, InferredBilling>;
  onSeenChange: (seen: SeenPatch) => void;
  // A concert has no stages or set times to show unless an act really has one (docs/specs/who-i-saw-lineup.md).
  concert?: boolean;
}

export const LineupTable: React.FC<LineupTableProps> = ({
  lineupActs,
  seen,
  sets: _sets,
  starts,
  daysAttended = [],
  inferredBilling,
  onSeenChange,
  concert = false,
}) => {
  const [lineupStage, setLineupStage] = useState<string>('all');
  const [lineupDay, setLineupDay] = useState<string>('all');
  const [lineupSearch, setLineupSearch] = useState<string>('');

  const lineupSlots = useMemo(
    () => groupReviewSlots(lineupActs.map((p) => ({ ...p, key: p.artistKey }))),
    [lineupActs],
  );
  const allStages = useMemo(
    () => Array.from(new Set(lineupActs.flatMap((p) => p.stages || []).filter(Boolean))).sort(),
    [lineupActs],
  );
  const allDays = useMemo(
    () => Array.from(new Set(lineupActs.flatMap((p) => p.days || []).filter(Boolean))).sort(),
    [lineupActs],
  );

  const matchingSlots = lineupSlots.filter((slot) => {
    if (lineupStage !== 'all') {
      const matchesStage = slot.items.some((it) => it.item.stages?.includes(lineupStage));
      if (!matchesStage) return false;
    }
    if (lineupDay !== 'all' && allDays.includes(lineupDay)) {
      const matchesDay = slot.items.some((it) => it.item.days?.includes(lineupDay));
      if (!matchesDay) return false;
    }
    if (lineupSearch.trim()) {
      const q = lineupSearch.toLowerCase();
      const matchesSearch = slot.items.some((it) => it.item.name.toLowerCase().includes(q));
      if (!matchesSearch) return false;
    }
    return true;
  });

  // A timed lineup reads as a timetable: earliest set first, untimed acts after.
  const slotStart = (slot: (typeof lineupSlots)[number]) =>
    slot.items.map((it) => starts.get(it.item.artistKey)).filter((t): t is string => Boolean(t)).sort()[0];
  const filteredSlots = byStartTime(matchingSlots, slotStart);

  const dayTabs = useMemo(() => {
    const items: Array<{ value: string; label: string; count: number }> = [
      { value: 'all', label: 'All', count: lineupSlots.length },
    ];
    for (const d of allDays) {
      const count = lineupSlots.filter((slot) => slot.items.some((it) => it.item.days?.includes(d))).length;
      items.push({ value: d, label: whenLabel({ startDate: d }) ?? d, count });
    }
    return items;
  }, [allDays, lineupSlots]);

  const stageOptions = useMemo(
    () => [{ value: 'all', label: 'All' }, ...allStages.map((s) => ({ value: s, label: s }))],
    [allStages],
  );

  const timedSetsForSlot = (slot: (typeof lineupSlots)[number]): SetTime[] => {
    const all = slot.items.flatMap((it) => actSets(it.item));
    if (lineupDay !== 'all') {
      const onDay = all.filter((s) => s.day === lineupDay);
      if (onDay.length) return onDay;
    } else if (daysAttended.length) {
      const onDays = all.filter((s) => s.day && daysAttended.includes(s.day));
      if (onDays.length) return onDays;
    }
    return all;
  };

  const toggleSlot = (slot: (typeof lineupSlots)[number], on: boolean, isSolo: boolean, slotKeys: Set<string>) => {
    if (on) {
      if (isSolo) {
        const artistKey = slot.items[0].item.artistKey;
        const nextSeen: SeenPatch = [];
        for (const s of seen) {
          if (s.key === artistKey && (!s.b2b?.length || !s.b2b)) continue;
          if (s.key === artistKey && s.solo) {
            const { solo: _s, soloSet: _ss, ...rest } = s;
            nextSeen.push(rest as SeenPatch[number]);
            continue;
          }
          nextSeen.push(s as SeenPatch[number]);
        }
        onSeenChange(toSeenInput(nextSeen as LoggedEvent['seen']));
      } else {
        const nextSeen = seen.filter(
          (s) => !(slotKeys.has(s.key) && s.b2b?.some((partner) => slotKeys.has(partner))),
        );
        onSeenChange(toSeenInput(nextSeen));
      }
    } else {
      if (isSolo) {
        const p = slot.items[0].item;
        onSeenChange([
          ...toSeenInput(seen),
          {
            name: p.name,
            from: 'lineup' as const,
            role: p.billing,
            roleFrom: p.billing ? ('lineup' as const) : undefined,
          },
        ]);
      } else {
        const newActs = slot.items.map((it) => {
          const p = it.item;
          const partners = slot.items
            .filter((other) => other.item.artistKey !== p.artistKey)
            .map((other) => other.item.artistKey);
          return {
            name: p.name,
            from: 'lineup' as const,
            role: p.billing,
            roleFrom: p.billing ? ('lineup' as const) : undefined,
            slotId: p.slotId,
            alias: p.alias,
            b2b: partners,
          };
        });
        onSeenChange([...toSeenInput(seen), ...newActs]);
      }
    }
  };

  const showTimes = !concert || lineupSlots.some((slot) => timedSetsForSlot(slot).some((t) => t.start || t.stage));

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="text-[11px] text-text-muted">
          From the lineup, tap to mark who you saw
          {filteredSlots.length !== lineupSlots.length ? ` (${filteredSlots.length} of ${lineupSlots.length})` : ''}:
        </p>
      </div>

      {(allDays.length > 1 || allStages.length > 1 || lineupSlots.length > 20) && (
        <div className="space-y-2">
          {allDays.length > 1 && (
            <Tabs
              label="Lineup days"
              items={dayTabs}
              value={lineupDay}
              onChange={setLineupDay}
              variant="folder"
              panel="surface-1"
            />
          )}

          {(allStages.length > 1 || lineupSlots.length > 20) && (
            <div className="flex flex-wrap items-center gap-2">
              {lineupSlots.length > 20 && (
                <input
                  type="search"
                  value={lineupSearch}
                  onChange={(e) => setLineupSearch(e.target.value)}
                  placeholder="Search acts..."
                  aria-label="Search lineup acts"
                  className="min-h-11 min-w-[12rem] flex-1 rounded-control border border-line bg-surface-2 px-3 text-sm text-text placeholder-text-faint focus:border-accent focus:outline-none sm:min-h-9"
                />
              )}

              {allStages.length > 1 && (
                allStages.length <= 4 ? (
                  <Segmented
                    label="Stage"
                    options={stageOptions}
                    value={lineupStage}
                    onChange={setLineupStage}
                  />
                ) : (
                  <label className="inline-flex items-center gap-2 text-xs text-text-muted">
                    <span>Stage</span>
                    <select
                      aria-label="Stage"
                      value={lineupStage}
                      onChange={(e) => setLineupStage(e.target.value)}
                      className="min-h-11 rounded-control border border-line-strong bg-surface-2 px-3 text-sm text-text focus:border-accent focus:outline-none sm:min-h-9"
                    >
                      <option value="all">All stages</option>
                      {allStages.map((stage) => (
                        <option key={stage} value={stage}>
                          {stage}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              )}
            </div>
          )}
        </div>
      )}

      {filteredSlots.length === 0 ? (
        <p className="py-3 text-xs text-text-muted">No acts match the selected stage or filter.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-none border border-line bg-surface-1">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-line bg-surface-2">
              <tr>
                <th scope="col" className="w-11 px-2 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  Saw
                </th>
                <th scope="col" className="px-2 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  Act
                </th>
                <th scope="col" className="px-2 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  Billed as
                </th>
                {showTimes && (
                  <>
                    <th scope="col" className="hidden px-2 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-text-muted sm:table-cell">
                      Stage
                    </th>
                    <th scope="col" className="px-2 py-2 text-right font-mono text-[11px] font-medium uppercase tracking-wider text-text-muted">
                      Set time
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredSlots.map((slot) => {
                const slotKeys = new Set(slot.items.map((it) => it.item.artistKey));
                const isSolo = slot.items.length === 1 && (!slot.items[0].item.b2b || slot.items[0].item.b2b.length === 0);
                const on = isSolo
                  ? seen.some((s) => s.key === slot.items[0].item.artistKey && (!s.b2b?.length || s.solo))
                  : slotKeys.size > 0 && [...slotKeys].every((k) => seen.some((s) => s.key === k && s.b2b?.some((partner) => slotKeys.has(partner))));

                const isHeadliner = slot.items.some((it) => it.item.billing === 'headliner');
                const isSupport = !isHeadliner && slot.items.some((it) => it.item.billing === 'support');
                const inferred = !isHeadliner && !isSupport
                  ? slot.items.map((it) => inferredBilling[it.item.artistKey]).find(Boolean)
                  : undefined;

                const timedSets = timedSetsForSlot(slot);
                const stages = Array.from(new Set(timedSets.map((s) => s.stage).filter((v): v is string => Boolean(v))));
                // B2B partners share one set, so each time shows once.
                const fullTimes = [...new Set(timedSets
                  .map((s) => {
                    const start = clock(s.start);
                    const end = clock(s.end);
                    return start ? (end ? `${start}–${end}` : start) : '';
                  })
                  .filter(Boolean))];
                const startOnly = [...new Set(timedSets.map((s) => clock(s.start)).filter((v): v is string => Boolean(v)))];

                const actDisplayName = isSolo
                  ? slot.name
                  : slot.items.map((it) => it.item.name).join(' b2b ');

                return (
                  <tr
                    key={slot.id}
                    className={`min-h-11 border-l-[3px] sm:min-h-10 ${
                      on
                        ? 'border-l-accent-fill bg-accent-tint/25'
                        : 'row-hover border-l-transparent'
                    }`}
                  >
                    <td className="p-0 align-middle">
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={on ? `Seen: ${actDisplayName}` : `Not seen: ${actDisplayName}`}
                        onClick={() => toggleSlot(slot, on, isSolo, slotKeys)}
                        className="flex min-h-11 w-full min-w-11 items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:min-h-10 sm:min-w-10"
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-5 w-5 items-center justify-center rounded-control border ${
                            on
                              ? 'border-accent bg-accent-fill text-on-accent'
                              : 'border-line-strong bg-surface-2'
                          }`}
                        >
                          {on && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                        </span>
                      </button>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <span className={`inline-flex flex-wrap items-center gap-1.5 text-sm ${on ? 'font-semibold text-text' : 'text-text'}`}>
                        <span>{actDisplayName}</span>
                        {!isSolo && (
<span className="text-xs text-text-muted">B2B</span>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      {isHeadliner ? (
                        <Pill tone="highlight">Headliner</Pill>
                      ) : isSupport ? (
                        <Pill tone="neutral">Support</Pill>
                      ) : inferred ? (
                        <InferredRole inferred={inferred} />
                      ) : (
                        <span className="text-xs text-text-muted">Artist</span>
                      )}
                    </td>
                    {showTimes && (
                    <>
                    <td className="hidden px-2 py-2 align-middle text-xs sm:table-cell">
                      {stages.length > 0 ? (
                        <span className="text-text">{stages.join(', ')}</span>
                      ) : (
                        <span className="text-text-faint">Not known yet</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right align-middle font-mono text-xs tabular-nums">
                      {fullTimes.length > 0 ? (
                        <>
                          <span className="hidden text-text sm:inline">{fullTimes.join(', ')}</span>
                          <span className="text-text sm:hidden">{startOnly[0]}</span>
                        </>
                      ) : (
                        <span className="text-text-faint">No time</span>
                      )}
                    </td>
                    </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showTimes && (
        <p className="text-[11px] text-text-muted">
          Set times and stages come only from timed sources. Acts without one say No time and Not known yet.
        </p>
      )}
    </div>
  );
};
