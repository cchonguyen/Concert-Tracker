import { cityFrom } from './read.ts';
import type { Quoted, ReadEmail } from './readerTypes.ts';
import { decodeEntities } from './text.ts';


// Reads an Apple Wallet .pkpass (a ZIP) in memory with Web Standards only.
// A pass counts as an event ticket only when its pass.json has an eventTicket
// block and none of the non-event pass types.

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_HEADER = 0x06054b50;
const NON_EVENT_KEYS = ['transitType', 'boardingPass', 'coupon', 'storeCard', 'generic'] as const;

export interface PassField {
  key: string;
  label?: string;
  value: string;
}

export interface PassTicket {
  name?: PassField;
  date?: string; // relevantDate, as the pass writes it
  fields: PassField[];
}

export async function readPkpass(bytes: Uint8Array): Promise<PassTicket | null> {
  const json = await unzipEntry(bytes, 'pass.json');
  if (!json) return null;
  let pass: Record<string, unknown>;
  try {
    pass = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (NON_EVENT_KEYS.some((k) => k in pass)) return null;
  const ticket = pass.eventTicket as Record<string, unknown> | undefined;
  if (!ticket || typeof ticket !== 'object') return null;

  const fields = [
    ...fieldsOf(ticket.primaryFields),
    ...fieldsOf(ticket.secondaryFields),
    ...fieldsOf(ticket.auxiliaryFields),
  ];
  const primary = fieldsOf(ticket.primaryFields)[0];
  return {
    name: primary,
    date: typeof pass.relevantDate === 'string' ? pass.relevantDate : undefined,
    fields,
  };
}

function fieldsOf(list: unknown): PassField[] {
  if (!Array.isArray(list)) return [];
  const out: PassField[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const { key, label, value } = f as Record<string, unknown>;
    if (typeof key !== 'string' || (typeof value !== 'string' && typeof value !== 'number')) continue;
    out.push({ key, label: typeof label === 'string' ? label : undefined, value: String(value) });
  }
  return out;
}

// Finds one named entry in a ZIP, via the central directory, and inflates it.
export async function unzipEntry(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CENTRAL_HEADER) return null;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const entryName = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (view.getUint32(localOffset, true) !== LOCAL_HEADER) return null;
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    if (method === 0) return data;
    if (method === 8) return inflateRaw(data);
    return null;
  }
  return null;
}

function findEndOfCentralDirectory(view: DataView): number {
  // The end record sits in the last 64 KiB plus its 22-byte fixed part.
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === END_HEADER) return i;
  }
  return -1;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- Layer 2 results as reads -------------------------------------------
// Each reader below returns what the machine markup states, every value with
// the exact text it was copied from, plus that text (`source`) so the scan
// can check each quote against it. Nothing is filled in when a key is absent.

export interface MarkupRead {
  read: ReadEmail;
  source: string[];
  by: 'schema_org' | 'pkpass' | 'ics';
}

const q = (value: string, quote = value): Quoted => ({ value, quote });
// A date-time with its own offset, or a plain date: the local day is its
// first ten characters. A UTC ("Z") time does not say the local day.
function localDay(value: string | undefined): Quoted | undefined {
  const v = value?.trim();
  if (!v || !/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}:?\d{2})?$)/.test(v)) return undefined;
  return q(v.slice(0, 10), v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function cityOf(locality: string | undefined, region: string | undefined): Quoted | undefined {
  if (!locality) return undefined;
  const c = region ? cityFrom(`${locality}, ${region}`) : undefined;
  return c ? q(c.value, locality) : undefined;
}

// schema.org EventReservation in JSON-LD, or in microdata.
export function readSchemaOrg(html: string | undefined): MarkupRead | null {
  if (!html) return null;
  return jsonLd(html) ?? microdata(html);
}

function jsonLd(html: string): MarkupRead | null {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1];
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const items = (Array.isArray(data) ? data : [data]).flatMap((d) => (d && typeof d === 'object' && Array.isArray((d as any)['@graph']) ? (d as any)['@graph'] : [d]));
    for (const item of items) {
      if (!item || typeof item !== 'object' || !/EventReservation$/.test(String((item as any)['@type']))) continue;
      const r = item as Record<string, any>;
      const ev = r.reservationFor ?? {};
      const loc = ev.location ?? {};
      const addr = typeof loc.address === 'object' ? loc.address : {};
      const name = str(ev.name);
      if (!name) continue;
      const status = String(r.reservationStatus ?? '');
      return {
        by: 'schema_org',
        source: [raw],
        read: {
          kind: /Cancel/i.test(status) ? 'cancelled' : 'order',
          name: q(name),
          startDate: localDay(str(ev.startDate)),
          endDate: localDay(str(ev.endDate)),
          venue: str(loc.name) ? q(str(loc.name)!) : undefined,
          city: cityOf(str(addr.addressLocality), str(addr.addressRegion)),
          orderId: str(r.reservationNumber),
        },
      };
    }
  }
  return null;
}

// Microdata: itemprop values in document order. "name" right after
// reservationFor is the event; "name" right after location is the venue.
function microdata(html: string): MarkupRead | null {
  if (!/itemtype=["']https?:\/\/schema\.org\/EventReservation["']/i.test(html)) return null;
  const props: Array<[string, string | undefined]> = [];
  for (const m of html.matchAll(/<[^>]*\bitemprop=["']([^"']+)["'][^>]*>/gi)) {
    const content = m[0].match(/\b(?:content|datetime)=["']([^"']*)["']/i)?.[1];
    props.push([m[1], content === undefined ? undefined : decodeEntities(content)]);
  }
  const after = (scope: string, key: string) => {
    const at = props.findIndex(([k]) => k === scope);
    return at < 0 ? undefined : props.slice(at + 1).find(([k, v]) => k === key && v)?.[1];
  };
  const get = (key: string) => props.find(([k, v]) => k === key && v)?.[1];
  const name = after('reservationFor', 'name');
  if (!name) return null;
  const status = get('reservationStatus') ?? '';
  return {
    by: 'schema_org',
    source: props.flatMap(([, v]) => (v ? [v] : [])),
    read: {
      kind: /Cancel/i.test(status) ? 'cancelled' : 'order',
      name: q(name),
      startDate: localDay(get('startDate')),
      venue: after('location', 'name') ? q(after('location', 'name')!) : undefined,
      city: cityOf(get('addressLocality'), get('addressRegion')),
      orderId: get('reservationNumber'),
    },
  };
}

const VENUE_FIELD = /venue|location|where/i;

// An event-ticket pass as a read: the first primary field is the event,
// relevantDate the day, a field labelled venue or location the venue.
export function passRead(t: PassTicket): MarkupRead | null {
  if (!t.name) return null;
  const venue = t.fields.find((f) => VENUE_FIELD.test(f.key) || VENUE_FIELD.test(f.label ?? ''));
  return {
    by: 'pkpass',
    source: [...t.fields.map((f) => f.value), ...(t.date ? [t.date] : [])],
    read: { kind: 'order', name: q(t.name.value), startDate: localDay(t.date), venue: venue ? q(venue.value) : undefined },
  };
}

// An .ics invite: SUMMARY, DTSTART and LOCATION ("Venue, street, City, ST").
// A UTC start ("...Z") does not give the local day, so it is left out.
export function readIcs(text: string): MarkupRead | null {
  const lines = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  const prop = (name: string) => lines.find((l) => new RegExp(`^${name}(?:;[^:]*)?:`, 'i').test(l));
  const value = (line: string | undefined) => line?.slice(line.indexOf(':') + 1).replace(/\\,/g, ',').trim();
  const summary = value(prop('SUMMARY'));
  if (!summary) return null;
  const startLine = prop('DTSTART');
  const start = value(startLine)?.match(/^(\d{4})(\d{2})(\d{2})(?:T\d{6})?$/);
  const location = value(prop('LOCATION'));
  const venue = location?.split(',')[0]?.trim();
  const parts = location?.split(',').map((s) => s.trim()) ?? [];
  const city = parts.length >= 3 ? cityFrom(`${parts[parts.length - 2]}, ${parts[parts.length - 1].replace(/\s+\d.*$/, '')}`) : undefined;
  return {
    by: 'ics',
    source: lines.map((l) => value(l) ?? l),
    read: {
      kind: 'order',
      name: q(summary),
      startDate: start ? q(`${start[1]}-${start[2]}-${start[3]}`, value(startLine)!) : undefined,
      venue: venue ? q(venue) : undefined,
      city: city ? q(city.value, parts[parts.length - 2]) : undefined,
    },
  };
}
