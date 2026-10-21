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
