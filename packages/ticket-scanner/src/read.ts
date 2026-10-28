import { normalizeName } from './names.ts';
import { cityLabel } from './place.ts';
import { readEmailDate } from './dates.ts';
import type { Quoted, ReadEmail } from './readerTypes.ts';

// Helpers the seller readers share. A reader only copies what its email
// states; anything it cannot find stays empty.

export const same = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b) && normalizeName(a!) === normalizeName(b!);

export const quoted = (value: string, quote = value): Quoted => ({ value, quote });

// The rest of the subject after a fixed opening ("Your tickets: MAURICE").
export function subjectAfter(subject: string, re: RegExp): string | undefined {
  const m = subject.replace(/\s+/g, ' ').trim().match(re);
  return m?.[1]?.trim() || undefined;
}

// The line whose text is the event name the subject gave.
export function indexOfName(lines: string[], name: string): number {
  return lines.findIndex((l) => same(l, name));
}

// The value after a label, on its own line ("Venue" / "Los Globos") or on
// the same line ("Venue Los Globos").
export function valueAfter(lines: string[], label: string, from = 0): { value: string; at: number } | undefined {
  const low = label.toLowerCase();
  for (let i = from; i < lines.length - 1; i++) if (lines[i].toLowerCase() === low) return { value: lines[i + 1], at: i + 1 };
  for (let i = from; i < lines.length; i++) {
    if (lines[i].toLowerCase().startsWith(`${low} `)) return { value: lines[i].slice(label.length).trim(), at: i };
  }
  return undefined;
}

export function dateFields(text: string, sentAt: string): Pick<ReadEmail, 'startDate' | 'endDate' | 'dateText'> {
  const d = readEmailDate(text, sentAt);
  if (!d) return {};
  if (!d.startDate) return { dateText: d.quote };
  return {
    startDate: quoted(d.startDate, d.quote),
    endDate: d.endDate ? quoted(d.endDate, d.quote) : undefined,
  };
}

// Sellers that name the ticket after the event ("DJ_Dave - Artist Presale",
// "2025 EDC Las Vegas - 3-Day GA Experience Pass"): the event is the part
// before the last " - " when that last part names a ticket type.
const TICKET_TYPE = /\s-\s(?:(?!\s-\s).)*\b(?:presale|admissions?|ga|general admission|vip|pass(?:es)?|parking|shuttle)\b(?:(?!\s-\s).)*$/i;
export const withoutTicketType = (name: string) => name.replace(TICKET_TYPE, '').trim() || name;

// "Location TBA" and the like are not a venue.
export function venueFrom(line: string | undefined): Quoted | undefined {
  const v = line?.trim();
  if (!v || /\b(tba|tbd|to be announced)\b/i.test(v) || /^\d/.test(v)) return undefined;
  return quoted(v);
}

// "Hollywood, CA" or "Los Angeles, California" as "City, ST".
export function cityFrom(text: string | undefined): Quoted | undefined {
  const t = text?.trim();
  const m = t?.match(/^([^,\d]+),\s*([A-Za-z .]+)$/);
  if (!m || /^(tba|tbd)$/i.test(m[1].trim())) return undefined;
  const label = cityLabel(m[1], m[2]);
  return label && label !== m[1].trim() ? quoted(label, t!) : undefined;
}

// The city from a US or Canadian postal address line:
// "3040 Sunset Blvd, Los Angeles, CA 90026, USA" or "San Francisco, CA 94102".
export function cityFromAddress(line: string | undefined): Quoted | undefined {
  const t = line?.trim();
  const m = t?.match(
    /(?:^|,\s*)([^,\d][^,]*?),\s*([A-Z]{2})\s+(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)(?:,\s*(?:USA|US|United States|Canada))?\s*$/,
  );
  const label = m && cityLabel(m[1], m[2]);
  return label ? quoted(label, t!) : undefined;
}

export const isAddress = (line: string | undefined) => Boolean(cityFromAddress(line));

export function count(line: string | undefined): number | undefined {
  const m = line?.match(/^(\d+)\s*(?:x|×)?\s/i) ?? line?.match(/^(\d+)\s+items?$/i);
  return m ? Number(m[1]) : undefined;
}

export function money(line: string | undefined): string | undefined {
  const m = line?.match(/(?:[$€£]\s?[\d,]+(?:\.\d{2})?|\bfree\b)/i);
  return m?.[0].replace(/\s+/g, '');
}

// The amount after a label, on its line ("Total: $42.50") or alone on the
// next ("Total:" / "$ 42.50").
export function moneyAfter(lines: string[], label: RegExp): string | undefined {
  const at = lines.findIndex((l) => label.test(l));
  if (at < 0) return undefined;
  const next = lines[at + 1];
  return money(lines[at].replace(label, '')) ?? (next && /^[$€£]\s?[\d,]+(?:\.\d{2})?$/.test(next) ? money(next) : undefined);
}
