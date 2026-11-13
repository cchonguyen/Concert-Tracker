// Grouping and filtering for the details picker when it offers many choices. Pure. City and month come from each
// candidate's own data only: no city means "City not stated", no month means "Month not stated", never a guess.
import type { DetailCandidate } from '../server/events/types';
import { candidateDateLabel, candidateRowParts } from './checkDetails';

export const PICKER_GROUP_OVER = 5;
export const NO_CITY_LABEL = 'City not stated';
export const NO_MONTH_LABEL = 'Month not stated';
export const NO_CITY_KEY = '';
export const NO_MONTH_KEY = '';

export interface PickerChip {
  key: string;
  label: string;
  count: number;
}

export interface PickerGroup {
  key: string;
  label: string;
  items: DetailCandidate[];
}

export interface PickerFilter {
  city?: string | null; // a city chip key
  month?: string | null; // a month chip key
  search?: string;
}

export interface PickerView {
  grouped: boolean; // false: show the plain list, no chips, no search
  cityChips: PickerChip[];
  monthChips: PickerChip[];
  groups: PickerGroup[];
  shown: number;
  total: number;
}

export function cityOf(c: DetailCandidate): { key: string; label: string } {
  const parts = [c.city, c.region].map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  if (!parts.length) return { key: NO_CITY_KEY, label: NO_CITY_LABEL };
  const label = parts.join(', ');
  return { key: label.toLowerCase(), label };
}

// "YYYY-MM" when the candidate's date states a month, else the no-month key.
export function monthOf(c: DetailCandidate): string {
  const m = /^(\d{4})-(\d{2})/.exec(c.startDate?.trim() ?? '');
  if (!m || !candidateDateLabel(`${m[1]}-${m[2]}`)) return NO_MONTH_KEY;
  return `${m[1]}-${m[2]}`;
}

function monthLabel(key: string): string {
  return key === NO_MONTH_KEY ? NO_MONTH_LABEL : (candidateDateLabel(key) ?? NO_MONTH_LABEL);
}

// The text a row shows, lower-cased, for the search box. `extra` adds text the row shows outside the parts (source names).
export function rowSearchText(c: DetailCandidate, extra = ''): string {
  const r = candidateRowParts(c);
  return [r.name, r.date, r.venue, r.place, r.sourceText, extra].join(' ').toLowerCase();
}

export function matchesFilter(c: DetailCandidate, f: PickerFilter, extra = ''): boolean {
  if (f.city != null && cityOf(c).key !== f.city) return false;
  if (f.month != null && monthOf(c) !== f.month) return false;
  const words = (f.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const text = rowSearchText(c, extra);
    if (!words.every((w) => text.includes(w))) return false;
  }
  return true;
}

export function cityChips(candidates: DetailCandidate[]): PickerChip[] {
  const out: PickerChip[] = [];
  for (const c of candidates) {
    const { key, label } = cityOf(c);
    const hit = out.find((x) => x.key === key);
    if (hit) hit.count += 1;
    else out.push({ key, label, count: 1 });
  }
  // Named cities keep first-seen order; the not-stated group goes last.
  return [...out.filter((x) => x.key !== NO_CITY_KEY), ...out.filter((x) => x.key === NO_CITY_KEY)];
}

export function monthChips(candidates: DetailCandidate[]): PickerChip[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(monthOf(c), (counts.get(monthOf(c)) ?? 0) + 1);
  const keys = [...counts.keys()].filter((k) => k !== NO_MONTH_KEY).sort();
  if (counts.has(NO_MONTH_KEY)) keys.push(NO_MONTH_KEY);
  return keys.map((key) => ({ key, label: monthLabel(key), count: counts.get(key) ?? 0 }));
}

// With 5 or fewer choices nothing changes: one group, in the order given, no chips. Above that, the chips list every
// city and month, and the groups hold the candidates that pass the filter, in their given order within each city.
export function buildPickerView(candidates: DetailCandidate[], filter: PickerFilter = {}, extraText: (c: DetailCandidate) => string = () => ''): PickerView {
  const total = candidates.length;
  if (total <= PICKER_GROUP_OVER) {
    return { grouped: false, cityChips: [], monthChips: [], groups: [{ key: 'all', label: '', items: candidates }], shown: total, total };
  }
  const chips = cityChips(candidates);
  const kept = candidates.filter((c) => matchesFilter(c, filter, extraText(c)));
  const groups: PickerGroup[] = chips
    .map((chip) => ({ key: chip.key, label: chip.label, items: kept.filter((c) => cityOf(c).key === chip.key) }))
    .filter((g) => g.items.length > 0);
  return { grouped: true, cityChips: chips, monthChips: monthChips(candidates), groups, shown: kept.length, total };
}
