// Splits the one line you type into name, date and place, in code and without
// a model. It only rearranges your own words: anything it cannot place stays
// in the name, and nothing is filled in that you did not write. Runs in the
// browser (live preview) and on the server (the saved result), so it must not
// import Node modules.

import { isoDate, MONTH_PATTERN, monthIndex } from '../lineup/months';

// One way research may read the line: words taken from what was typed, never
// anything added.
export interface Reading {
  name: string;
  venue?: string;
  city?: string;
}

export interface ParsedInput {
  name: string;
  /** The full text you typed (whitespace tidied), kept whole. */
  text: string;
  /** Up to 2 readings of the line for research to try; always at least one. */
  readings: Reading[];
  year?: number;
  month?: number;
  startDate?: string;
  endDate?: string;
  weekend?: number;
  venue?: string;
  city?: string;
}

const MONTH = MONTH_PATTERN;
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '((?:19|20)\\d{2})';

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

// Every full date written in a text (a search result, say), in order, with
// the words it was read from. Month-only and bare years are not dates here.
export function findDates(text: string): Array<{ startDate: string; endDate?: string; quote: string }> {
  const found: Array<{ startDate: string; endDate?: string; quote: string; at: number }> = [];
  const taken: Array<[number, number]> = [];
  for (const rule of DATE_RULES) {
    for (const m of text.matchAll(new RegExp(rule.re.source, `${rule.re.flags}g`))) {
      const start = m.index!;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue; // an earlier rule read these words
      const hit = rule.read(m);
      if (!hit?.startDate) continue;
      taken.push([start, end]);
      found.push({ startDate: hit.startDate, endDate: hit.endDate, quote: m[0].trim(), at: start });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...d }) => d);
}

// A bare year. "The 1975" is a band, so a year right after "the" is not a date.
const BARE_YEAR = /(^|[^\w-])((?:19|20)\d{2})(?![\w-])/g;

// Explicit weekend token ("weekend 2", "wknd 1", "W2") requiring digit 1..9 so
// band/event names like "Vampire Weekend" or "The Weeknd" are never touched.
const WEEKEND_RE = /\b(?:weekend|wknd)\s*([1-9])\b|\bw([1-9])\b/i;

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

  let weekend: number | undefined;
  const wm = text.match(WEEKEND_RE);
  if (wm) {
    weekend = Number(wm[1] ?? wm[2]);
    const stripped = `${text.slice(0, wm.index!)} ${text.slice(wm.index! + wm[0].length)}`;
    const atSplit = text.match(/^(.*?)\s(?:at|@)\s(.*)$/i) ?? text.match(/^(.*?)@(.*)$/);
    if (atSplit && tidy(atSplit[1])) {
      const inName = wm.index! < atSplit[1].length;
      const strippedAt = stripped.match(/^(.*?)\s(?:at|@)\s(.*)$/i) ?? stripped.match(/^(.*?)@(.*)$/);
      if (inName ? Boolean(strippedAt && tidy(strippedAt[1])) : Boolean(strippedAt && tidy(strippedAt[2]))) {
        text = stripped;
      }
    } else if (tidy(stripped)) {
      text = stripped;
    }
  }

  // Place: "<name> at|@ <venue>[, <city>]". Only " at ", "@" and a comma
  // after them mark a place; " in " alone never splits (it is only offered as
  // an alternative reading for research).
  let name = text;
  let venue: string | undefined;
  let city: string | undefined;
  const at = text.match(/^(.*?)\s(?:at|@)\s(.*)$/i) ?? text.match(/^(.*?)@(.*)$/);
  const whole = tidy(text);
  const readings: Reading[] = [];
  const addReading = (r: Reading) => {
    const clean: Reading = { name: r.name };
    if (r.venue) clean.venue = r.venue;
    if (r.city) clean.city = r.city;
    if (!clean.name || readings.length >= 2) return;
    if (readings.some((x) => x.name === clean.name && x.venue === clean.venue && x.city === clean.city)) return;
    readings.push(clean);
  };
  if (at && tidy(at[1])) {
    name = at[1];
    const parts = at[2].split(',');
    venue = tidy(parts[0]) || undefined;
    city = tidy(parts.slice(1).join(',')) || undefined;
    addReading({ name: tidy(name), venue, city });
    addReading({ name: whole });
  } else {
    addReading({ name: whole });
    const inCity = text.match(/^(.*)\s+in\s+(.*)$/i);
    const comma = text.match(/^(.*),(.*)$/);
    const alt = inCity ?? comma;
    if (alt && tidy(alt[1]) && tidy(alt[2])) addReading({ name: tidy(alt[1]), city: tidy(alt[2]) });
  }

  const out: ParsedInput = { name: tidy(name), ...dates, weekend, venue, city, text: tidy(raw), readings };
  for (const k of Object.keys(out) as Array<keyof ParsedInput>) if (out[k] === undefined) delete out[k];
  return out;
}
