import type { CandidateSource, SetTime } from '../lineup/types';

// When and where an act played, as its sources time it (Clashfinder gives
// stage, start and end). Read only from cited sources; an act with no timed
// source has no set time. Browser-safe: the event view uses it.

export function actSets(perf: { sources: CandidateSource[] }): SetTime[] {
  const out: SetTime[] = [];
  for (const s of perf.sources) {
    for (const set of s.sets ?? []) {
      if (!out.some((x) => x.start === set.start && x.stage === set.stage)) out.push(set);
    }
  }
  return out.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}

const clock = (t?: string) => t?.match(/[ T](\d{2}:\d{2})/)?.[1];

// "Kinetic Field · Sat 19:00–20:15"; the day is left out for a one-day event.
export function setLabel(set: SetTime, withDay: boolean): string {
  const start = clock(set.start);
  const end = clock(set.end);
  const time = start ? (end ? `${start}–${end}` : start) : '';
  const day =
    withDay && set.day
      ? new Date(`${set.day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' })
      : '';
  return [set.stage, [day, time].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

// Short time for a lineup chip: "Fri 19:00", or "19:00" for a one-day event.
// Several sets read "Fri 19:00 +1". No timed source, no label.
export function chipTime(sets: SetTime[], withDay: boolean): string | undefined {
  const first = sets.find((s) => clock(s.start));
  if (!first) return undefined;
  const day =
    withDay && first.day
      ? new Date(`${first.day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' })
      : '';
  const more = sets.filter((s) => clock(s.start)).length - 1;
  return [day, clock(first.start), more > 0 ? `+${more}` : ''].filter(Boolean).join(' ');
}

// Timed acts first, by earliest start; untimed acts keep their order after them.
// Leaves the list as it is when nothing is timed.
export function byStartTime<T>(items: T[], startOf: (item: T) => string | undefined): T[] {
  const starts = items.map(startOf);
  if (!starts.some(Boolean)) return items;
  return items
    .map((item, i) => ({ item, i, start: starts[i] }))
    .sort((a, b) => (a.start && b.start ? a.start.localeCompare(b.start) || a.i - b.i : a.start ? -1 : b.start ? 1 : a.i - b.i))
    .map((x) => x.item);
}
