// Vendored from LiveArchive email/dates.ts so this package has no host imports.
// Event dates as ticket emails write them, read in code. Sellers often leave
// the year out ("Sat Aug 29, 10:00 PM"). The year is then the only one, from
// the sending day to a year later, in which that day falls on the weekday
// the email gives. Without a weekday there is no year and no date; the words
// are kept for you to read. Nothing here guesses.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY = '(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?';
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '((?:19|20)\\d{2})';
// [weekday] Month Day [year] | [weekday] Day Month [year]
const TOKEN = new RegExp(
  `(?:\\b${WEEKDAY},?\\s+)?(?:\\b${MONTH}\\s+${DAY}\\b|\\b${DAY}\\s+${MONTH}(?![a-z]))(?:,?\\s+${YEAR}\\b)?`,
  'gi',
);
const TIME = /\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/gi;
const DAY_MS = 864e5;

interface Token {
  weekday?: number;
  month: number;
  day: number;
  year?: number;
  at: number;
  end: number;
}

export interface EmailDate {
  startDate?: string;
  endDate?: string;
  quote: string; // the date words, as written
}

function iso(year: number, month: number, day: number): string | undefined {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : undefined;
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const monthWord = m[2] ?? m[5];
    const dayWord = m[3] ?? m[4];
    out.push({
      weekday: m[1] ? DAYS.indexOf(m[1].slice(0, 3).toLowerCase()) : undefined,
      month: MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) + 1,
      day: Number(dayWord),
      year: m[6] ? Number(m[6]) : undefined,
      at: m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

// The year in which month/day falls on the weekday, from (just before) the
// sending day to a year after it. Two such years cannot both fit.
export function yearFromWeekday(month: number, day: number, weekday: number, sentAt: string): number | undefined {
  const sent = sentAt.slice(0, 10);
  const sentYear = Number(sent.slice(0, 4));
  for (const year of [sentYear, sentYear + 1]) {
    const date = iso(year, month, day);
    if (!date || weekdayOf(date) !== weekday) continue;
    const days = (Date.parse(date) - Date.parse(sent)) / DAY_MS;
    if (days >= -2 && days <= 366) return year;
  }
  return undefined;
}

// A night that ends the next morning (a club night until 5 AM) is one event
// on its first day, not a two-day event.
function endsNextMorning(text: string, start: string, end: string): boolean {
  if (end !== addDays(start, 1)) return false;
  const times = [...text.matchAll(TIME)];
  const last = times[times.length - 1];
  if (!last) return false;
  let hour = Number(last[1]);
  const half = last[3]?.toLowerCase().replace(/\./g, '');
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  return hour < 12;
}

// Reads the first date (and an end date, if the text gives a range) from
// the date words of one email. Returns null when no date words are present.
export function readEmailDate(text: string, sentAt: string): EmailDate | null {
  const found = tokens(text);
  if (!found.length) return null;
  const first = found[0];
  const last = found.length > 1 ? found[found.length - 1] : undefined;
  const quote = text.slice(first.at, (last ?? first).end).trim();

  let startYear = first.year;
  let endYear = last?.year;
  if (!startYear && endYear && last) startYear = first.month > last.month ? endYear - 1 : endYear;
  if (!startYear && first.weekday !== undefined) startYear = yearFromWeekday(first.month, first.day, first.weekday, sentAt);
  if (!startYear) return { quote };
  if (last && !endYear) endYear = last.month < first.month ? startYear + 1 : startYear;

  const startDate = iso(startYear, first.month, first.day);
  if (!startDate || (first.weekday !== undefined && weekdayOf(startDate) !== first.weekday)) return { quote };
  let endDate = last && endYear ? iso(endYear, last.month, last.day) : undefined;
  if (endDate && last?.weekday !== undefined && weekdayOf(endDate) !== last.weekday) return { quote };
  if (endDate && (endDate <= startDate || endsNextMorning(text, startDate, endDate))) endDate = undefined;
  return { startDate, endDate, quote };
}
