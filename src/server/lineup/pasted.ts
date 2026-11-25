import type { SetTime } from './types';
import { addDays, daysBetween } from './text';

// Set times from a page the owner pasted into the app (docs/specs/pasted-set-times.md).
// Read in code only: an act is a name line followed by a time line. Dates come
// from the event, never from the paste. A stage is kept only when one line
// naming it sits directly before its group of acts; anything else stays missing.

export interface PastedSet {
  name: string;
  quote: string; // the name line and the time line, exactly as pasted
  set?: SetTime; // missing when the time cannot be placed on a day of the event
}

export interface PastedRead {
  sets: PastedSet[];
  unread: string[]; // lines that were not part of an act or a heading
}

interface Clock {
  h: number;
  m: number;
  meridiem?: 'am' | 'pm';
}

const CLOCK = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m?\.?`;
const CLOCK_24 = String.raw`(\d{1,2})[:.](\d{2})`;
const RANGE_12 = new RegExp(String.raw`^${CLOCK}\s*(?:-|–|—|to)\s*${CLOCK}$`, 'i');
const RANGE_24 = new RegExp(String.raw`^${CLOCK_24}\s*(?:-|–|—|to)\s*${CLOCK_24}$`, 'i');
const SINGLE_12 = new RegExp(String.raw`^${CLOCK}$`, 'i');
const SINGLE_24 = new RegExp(String.raw`^${CLOCK_24}$`);
const OPEN_RANGE_12 = new RegExp(String.raw`^(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|to)\s*${CLOCK}$`, 'i');

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function clock(h: string, m: string | undefined, ap?: string): Clock | null {
  const hour = Number(h);
  const minute = m ? Number(m) : 0;
  if (minute > 59) return null;
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    return { h: hour, m: minute, meridiem: ap.toLowerCase() === 'a' ? 'am' : 'pm' };
  }
  if (hour > 23) return null;
  return { h: hour, m: minute };
}

// "9:30pm - 10:45pm", "12am - 2am", "21:30–22:45", "9:30 - 10:45pm", "21:30" or "9pm".
export function readTimeLine(line: string): { start: Clock; end?: Clock } | null {
  const t = line.trim();
  let m = t.match(RANGE_12);
  if (m) {
    const start = clock(m[1], m[2], m[3]);
    const end = clock(m[4], m[5], m[6]);
    return start && end ? { start, end } : null;
  }
  m = t.match(OPEN_RANGE_12);
  if (m) {
    // "9:30 - 10:45pm": the start has no am/pm of its own, so it is not placed.
    return null;
  }
  m = t.match(RANGE_24);
  if (m) {
    const start = clock(m[1], m[2]);
    const end = clock(m[3], m[4]);
    return start && end ? { start, end } : null;
  }
  m = t.match(SINGLE_12);
  if (m) {
    const start = clock(m[1], m[2], m[3]);
    return start ? { start } : null;
  }
  m = t.match(SINGLE_24);
  if (m) {
    const start = clock(m[1], m[2]);
    return start ? { start } : null;
  }
  return null;
}

function hour24(c: Clock): number {
  if (!c.meridiem) return c.h;
  if (c.meridiem === 'am') return c.h === 12 ? 0 : c.h;
  return c.h === 12 ? 12 : c.h + 12;
}

const pad = (n: number) => String(n).padStart(2, '0');

// A set starting before 06:00 belongs to the festival day before it (the rule
// Clashfinder's sets already follow), so it is placed on the next calendar day.
function stamp(day: string, c: Clock, after?: string): string {
  const h = hour24(c);
  let date = h < 6 ? addDays(day, 1) : day;
  let value = `${date} ${pad(h)}:${pad(c.m)}`;
  if (after && value <= after) {
    date = addDays(date, 1);
    value = `${date} ${pad(h)}:${pad(c.m)}`;
  }
  return value;
}

// A day heading names a day of the event: "Day 2", "Saturday", "Sat", or a date
// in the event's month ("Dec 31", "31 December", "2024-12-31").
export function readDayHeading(line: string, days: string[]): { day?: string } | null {
  const t = line.trim().toLowerCase().replace(/[,.]/g, '');
  const n = t.match(/^day\s*(\d{1,2})$/);
  if (n) return { day: days[Number(n[1]) - 1] };
  const iso = t.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (iso) return { day: days.includes(iso[1]) ? iso[1] : undefined };
  const word = t.match(/^([a-z]+)$/);
  if (word) {
    const idx = WEEKDAYS.findIndex((d) => d === word[1] || (word[1].length >= 3 && d.startsWith(word[1]) && word[1].length <= d.length));
    if (idx < 0) return null;
    const hits = days.filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === idx);
    return { day: hits.length === 1 ? hits[0] : undefined };
  }
  return null;
}

export function parsePastedSets(text: string, event: { startDate: string; endDate?: string }): PastedRead {
  const days = daysBetween(event.startDate, event.endDate ?? event.startDate);
  const oneDay = days.length === 1;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const sets: PastedSet[] = [];
  const unread: string[] = [];
  let day: string | undefined = oneDay ? days[0] : undefined;
  let stage: string | undefined;
  let run: string[] = []; // unpaired lines since the last act or heading

  const flushRun = () => {
    unread.push(...run.map((l) => l.trim()));
    run = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const heading = readDayHeading(line, days);
    if (heading) {
      flushRun();
      if (!oneDay) day = heading.day;
      stage = undefined;
      continue;
    }
    if (readTimeLine(line)) {
      // A time with no name line before it (an hour marker on a grid).
      flushRun();
      continue;
    }
    const next = lines.slice(i + 1).find((l) => l.trim())?.trim();
    const time = next ? readTimeLine(next) : null;
    if (!next || !time) {
      run.push(line);
      continue;
    }
    // A new group: exactly one unpaired line before it names its stage.
    if (run.length === 1) {
      stage = run[0];
      run = [];
    } else if (run.length > 1) {
      flushRun();
      stage = undefined;
    }
    i = lines.indexOf(lines.slice(i + 1).find((l) => l.trim())!, i + 1);
    const quote = `${line}\n${next}`;
    let set: SetTime | undefined;
    if (day) {
      const start = stamp(day, time.start);
      const end = time.end ? stamp(day, time.end, start) : undefined;
      set = { day, start, ...(end ? { end } : {}), ...(stage ? { stage } : {}) };
    }
    sets.push({ name: line, quote, ...(set ? { set } : {}) });
  }
  flushRun();
  return { sets, unread };
}
