import { decryptField, isCiphertext, type VaultKeys } from './vault';

// "Download my data" for a member with a vault: the server's export holds
// notes and people as ciphertext, so the browser opens them with the unlocked
// keys and downloads readable events. Nothing readable is sent back to the server.

type Row = Record<string, any>;
export interface ExportBundle {
  events?: Row[];
  records?: Row[];
  [k: string]: unknown;
}

export const hasCiphertext = (bundle: ExportBundle): boolean =>
  Boolean(bundle.events?.some((e) => isCiphertext(e.notes) || e.personIds?.length) || bundle.records?.some((r) => r.nameEncrypted));

export async function decryptBundle(bundle: ExportBundle, keys: VaultKeys): Promise<ExportBundle> {
  const names = new Map<string, string>();
  const records: Row[] = [];
  for (const r of bundle.records ?? []) {
    if (!r.nameEncrypted) {
      records.push(r);
      continue;
    }
    const { nameEncrypted, ...rest } = r;
    const name = await decryptField(keys, nameEncrypted);
    names.set(r.id, name);
    records.push({ ...rest, name, attrs: await decryptDetails(r.attrs, keys) });
  }
  // A merged person's events already list the one they were merged into.
  const nameOf = (id: string) => names.get(id);
  const events: Row[] = [];
  for (const e of bundle.events ?? []) {
    const { personIds, ...rest } = e;
    const people = ((personIds ?? []) as string[]).map(nameOf).filter((n): n is string => Boolean(n));
    events.push({
      ...rest,
      notes: isCiphertext(e.notes) ? await decryptField(keys, e.notes) : e.notes,
      companions: [...(e.companions ?? []), ...people],
    });
  }
  return { ...bundle, events, records };
}

async function decryptDetails(attrs: Row | undefined, keys: VaultKeys): Promise<Row> {
  if (!attrs || !isCiphertext(attrs.enc)) return attrs ?? {};
  const { enc, ...rest } = attrs;
  try {
    return { ...rest, ...JSON.parse(await decryptField(keys, enc)) };
  } catch {
    return rest;
  }
}
