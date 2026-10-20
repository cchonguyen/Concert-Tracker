// Splits the one line you type into name, date and place, in code and without
// a model. It only rearranges your own words: anything it cannot place stays
// in the name, and nothing is filled in that you did not write. Runs in the
// browser (live preview) and on the server (the saved result), so it must not
// import Node modules.

export interface ParsedInput {
  name: string;
  year?: number;
  month?: number;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '((?:19|20)\\d{2})';

const monthIndex = (m: string) => MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1;

function isoDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return undefined; // e.g. Feb 30
  return d.toISOString().slice(0, 10);
}

type DateHit = Pick<ParsedInput, 'year' | 'month' | 'startDate' | 'endDate'>;

// Each rule returns the dates it read, or null to let the next rule try.
const DATE_RULES: Array<{ re: RegExp; read: (m: RegExpMatchArray) => DateHit | null }> = [
  {
    // 2024-10-05, optionally a range to 2024-10-07
    re: /\b(\d{4})-(\d{2})-(\d{2})(?:\s*(?:to|-|–|—)\s*(\d{4})-(\d{2})-(\d{2}))?\b/,
    read: (m) => {
      const start = isoDate(+m[1], +m[2], +m[3]);
      const end = m[4] ? isoDate(+m[4], +m[5], +m[6]) : undefined;
      return start ? { startDate: start, endDate: end && end > start ? end : undefined } : null;
    },
  },
  {
    // 10/5/2024 or 10/5/24 (month first)
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/,
    read: (m) => {
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      const start = isoDate(year, +m[1], +m[2]);
      return start ? { startDate: start } : null;
    },
  },
  {
    // Oct 5 2024, October 5th, 2024, May 16-18 2025, May 30 - June 1, 2025
    re: new RegExp(`\\b${MONTH}\\s+${DAY}(?:\\s*(?:-|–|—|to)\\s*(?:${MONTH}\\s+)?${DAY})?,?\\s+${YEAR}\\b`, 'i'),
    read: (m) => {
      const year = +m[5];
      const start = isoDate(year, monthIndex(m[1]), +m[2]);
      const end = m[4] ? isoDate(year, m[3] ? monthIndex(m[3]) : monthIndex(m[1]), +m[4]) : undefined;
      return start ? { startDate: start, endDate: end && end > start ? end : undefined } : null;
    },
  },
  {
    // 5 Oct 2024, 16-18 May 2025
    re: new RegExp(`\\b${DAY}(?:\\s*(?:-|–|—)\\s*${DAY})?\\s+${MONTH},?\\s+${YEAR}\\b`, 'i'),
    read: (m) => {
      const year = +m[4];
      const start = isoDate(year, monthIndex(m[3]), +m[1]);
      const end = m[2] ? isoDate(year, monthIndex(m[3]), +m[2]) : undefined;
      return start ? { startDate: start, endDate: end && end > start ? end : undefined } : null;
    },
  },
  {
    // October 2024
    re: new RegExp(`\\b${MONTH},?\\s+${YEAR}\\b`, 'i'),
    read: (m) => ({ year: +m[2], month: monthIndex(m[1]) }),
  },
];

// A bare year. "The 1975" is a band, so a year right after "the" is not a date.
const BARE_YEAR = /(^|[^\w-])((?:19|20)\d{2})(?![\w-])/g;

function tidy(value: string): string {
  return value
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|·\-–—/]+|[\s,;:|·\-–—/]+$/g, '')
    .trim();
}

export function parseEventInput(raw: string): ParsedInput {
  let text = ` ${raw.replace(/\s+/g, ' ').trim()} `;
  let dates: DateHit = {};

  for (const rule of DATE_RULES) {
    const m = text.match(rule.re);
    const hit = m && rule.read(m);
    if (m && hit) {
      dates = hit;
      text = text.replace(m[0], ' ');
      break;
    }
  }
  if (!dates.startDate && !dates.year) {
    const years = [...text.matchAll(BARE_YEAR)].filter((m) => !/\bthe\s*$/i.test(text.slice(0, m.index! + m[1].length)));
    const last = years[years.length - 1];
    if (last) {
      dates = { year: +last[2] };
      text = text.slice(0, last.index! + last[1].length) + ' ' + text.slice(last.index! + last[0].length);
    }
  }
  if (dates.startDate) dates.year = +dates.startDate.slice(0, 4);

  // Place: "<name> at|@ <venue>[, <city>]" or "<name> in <city>".
  let name = text;
  let venue: string | undefined;
  let city: string | undefined;
  const at = text.match(/^(.*?)\s(?:at|@)\s(.*)$/i) ?? text.match(/^(.*?)@(.*)$/);
  if (at && tidy(at[1])) {
    name = at[1];
    const place = at[2];
    const inCity = place.match(/^(.*?)\s+in\s+(.*)$/i);
    const parts = inCity ? [inCity[1], inCity[2]] : place.split(',');
    venue = tidy(parts[0]) || undefined;
    city = tidy(parts.slice(1).join(',')) || undefined;
  } else {
    const inCity = text.match(/^(.*)\s+in\s+(.*)$/i);
    if (inCity && tidy(inCity[1]) && tidy(inCity[2])) {
      name = inCity[1];
      city = tidy(inCity[2]);
    }
  }

  const out: ParsedInput = { name: tidy(name), ...dates, venue, city };
  for (const k of Object.keys(out) as Array<keyof ParsedInput>) if (out[k] === undefined) delete out[k];
  return out;
}
