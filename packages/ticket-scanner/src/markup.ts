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
