// The poster header and the things-left strip for an event detail. Pure: the screen passes in what is stored,
// and gets back what to draw. Sizes come from the billing role and never from list order.
import type { LoggedEvent, SeenAct } from '../server/events/types';
import type { EditionHeader } from '../server/lineup/types';
import type { Gap } from './table';
import { GAPS, tableDate } from './table';

// The date as the detail and the list show it, e.g. "12 Jun 2026" (or "Jun 2026" when the day is not known).
export function dateText(e: Parameters<typeof tableDate>[0]): string {
  const d = tableDate(e);
  return d ? [d.day, d.month, d.year].filter(Boolean).join(' ') : '';
}

export interface BillLines {
  large: SeenAct[]; // Headliners you saw, or, when none is billed as one, the seen acts with no role.
  medium: SeenAct[]; // Every other act you saw.
  more: number; // Cited lineup acts you did not see, counted for "+ N more".
}

// The bill for the poster. `cited` is the keys of the lineup's acts; any of them not seen is counted, never drawn.
export function billLines(seen: SeenAct[], cited: string[] = []): BillLines {
  const headliners = seen.filter((s) => s.role === 'headliner');
  const large = headliners.length > 0 ? headliners : seen.filter((s) => !s.role);
  const shown = new Set(large.map((s) => s.key));
  const medium = seen.filter((s) => !shown.has(s.key));
  const seenKeys = new Set(seen.map((s) => s.key));
  const more = new Set(cited.filter((k) => !seenKeys.has(k))).size;
  return { large, medium, more };
}

// The order the things-left strip lists gaps in: who you saw and the days first, then the set, then the rest in
// the order the table uses.
const FIRST: Gap[] = ['seen', 'date', 'favourite'];
export function thingsLeft<E>(e: E, gapOf: (e: E, gap: Gap) => boolean): Gap[] {
  const gaps = GAPS.filter((g) => !FIRST.includes(g));
  return [...FIRST, ...gaps].filter((g) => gapOf(e, g));
}

export const GAP_LABEL: Record<Gap, string> = {
  date: 'Dates',
  venue: 'Venue',
  city: 'City',
  place: 'State and country',
  type: 'Concert or festival',
  format: 'Format',
  seen: 'Who you saw',
  favourite: 'Favourite set',
  companions: 'Went with',
  rating: 'Rating',
  price: 'Price',
  weather: 'Weather',
  review: 'Review',
  lineup: 'Lineup',
};

// The section of the detail each gap is filled in, by its id on the page.
export type SectionId = 'when-where' | 'who-you-saw' | 'your-notes';
export const GAP_SECTION: Record<Gap, SectionId> = {
  date: 'when-where',
  venue: 'when-where',
  city: 'when-where',
  place: 'when-where',
  type: 'when-where',
  weather: 'when-where',
  seen: 'who-you-saw',
  favourite: 'who-you-saw',
  companions: 'your-notes',
  rating: 'your-notes',
  price: 'your-notes',
  format: 'your-notes',
  review: 'your-notes',
  lineup: 'who-you-saw',
};

// The guided question a gap asks, shown on the strip's Next button.
export const GAP_QUESTION: Record<Gap, string> = {
  date: 'When was it?',
  venue: 'Where was it?',
  city: 'Which city?',
  place: 'Which state and country?',
  type: 'Concert or festival?',
  format: 'What format was it?',
  seen: 'Who did you see?',
  favourite: 'Which set was your favourite?',
  companions: 'Who did you go with?',
  rating: 'How would you rate it?',
  price: 'What did you pay?',
  weather: 'Want the weather for the day?',
  review: 'Anything to remember about it?',
  lineup: 'Add the act the edition is named for?',
};

// True when an event is linked to a multi-weekend edition and has neither a weekend nor a startDate yet.
export function needsWeekendPrompt(
  event: Pick<LoggedEvent, 'editionId' | 'weekend' | 'startDate'>,
  edition?: Pick<EditionHeader, 'weekends'> | null,
): boolean {
  return Boolean(event.editionId && edition?.weekends && edition.weekends.length > 1 && !event.weekend && !event.startDate);
}

// The question shown in ThingsLeft, using "Which weekend?" when a linked multi-weekend event needs its weekend.
export function gapQuestion(gap: Gap, opts?: { needsWeekend?: boolean }): string {
  if (gap === 'date' && opts?.needsWeekend) return 'Which weekend?';
  return GAP_QUESTION[gap];
}
