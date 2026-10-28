import type { RawEmailMessage as RawEmail } from './types.ts';

// A ticket email someone forwarded to you. Gmail ("---------- Forwarded
// message ---------") and iPhone Mail ("Begin forwarded message:") put the
// original's From, Date, Subject and To lines above its body. The original
// is read by its seller's reader as if it had come to you, from the lines
// below the innermost header (a forward of a forward has one header per
// hop). See ARCHITECTURE.md ("Stage 1 from email").

const MARKER = /^(?:-+\s*Forwarded message\s*-+|Begin forwarded message:?)$/i;
const HEADER = /^(From|Date|Sent|Subject|To|Cc|Reply-To):\s*(.*)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "Wed, Apr 1, 2026 at 10:06 AM", "July 14, 2023 at 12:39:07 PM PDT", "Tue, Feb 7, 2023, 3:52 PM"
const HEADER_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i;

export interface Forwarded {
  email: RawEmail; // the original: its sender, subject and send date, under the forward's id and link
  lines: string[]; // the original's lines
  dated: boolean; // false: the header gave no date the year rule can count from
}

// The day the original was sent, from the header's Date line.
function headerDay(value: string): string | undefined {
  const m = value.match(HEADER_DATE);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[2]), 12));
  return d.getUTCDate() === Number(m[2]) ? d.toISOString() : undefined;
}

export function unwrapForward(email: RawEmail, lines: string[]): Forwarded | null {
  let found: Forwarded | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!MARKER.test(lines[i])) continue;
    const headers: Record<string, string> = {};
    let end = i + 1;
    while (end < lines.length && HEADER.test(lines[end])) {
      const [, name, value] = lines[end].match(HEADER)!;
      headers[name.toLowerCase()] ??= value.trim();
      end++;
    }
    if (!headers.from || !headers.subject) continue;
    const day = headerDay(headers.date ?? headers.sent ?? '');
    found = {
      email: { ...email, from: headers.from, subject: headers.subject, sentAt: day ?? email.sentAt, html: undefined, text: undefined },
      lines: lines.slice(end),
      dated: Boolean(day),
    };
    i = end - 1;
  }
  return found;
}
