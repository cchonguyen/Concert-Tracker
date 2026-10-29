import { decryptField, encryptField, nameToken, type VaultKeys } from './vault';
import { norm } from './listImport';
import type { LoggedEvent } from '../server/events/types';

// The people who went with you, once the vault is on. The server holds each
// person as an opaque record: an encrypted name, an encrypted details blob, and
// the tokens that let a typed name find them. This module is the browser's
// side: it opens names with the unlocked keys, finds or makes a person for a
// typed name, and changes events between the names the page works with
// (`companions`) and the record ids the server stores (`personIds`).

export interface PersonRecord {
  id: string;
  nameEncrypted: string;
  enc?: string;
  mergedIntoId?: string;
  tokens: string[];
}
export interface PlainPerson {
  id: string;
  name: string;
  attrs?: Record<string, unknown>;
  mergedIntoId?: string;
  aliases: string[];
}
export interface PeopleServer {
  list(): Promise<{ people: PersonRecord[]; plain: PlainPerson[] }>;
  put(id: string, body: { nameEncrypted: string; tokens: string[]; enc?: string }): Promise<unknown>;
  merge(id: string, into: string): Promise<unknown>;
  convert(id: string, to: string): Promise<unknown>;
  finish(): Promise<unknown>;
}

// What Manage shows and edits about a person; encrypted as one blob.
export interface PersonDetails {
  first?: string;
  last?: string;
  note?: string;
  aliases?: string[]; // other names that lead to this person
}

export interface Person {
  id: string;
  name: string;
  details: PersonDetails;
  mergedIntoId?: string;
}

export class PeopleBook {
  private readonly people = new Map<string, Person & { tokens: string[] }>();
  private readonly byToken = new Map<string, string>();

  constructor(
    private readonly keys: VaultKeys,
    private readonly server: PeopleServer,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  // Reads every person, and returns the plain ones that still need converting.
  async load(): Promise<PlainPerson[]> {
    const { people, plain } = await this.server.list();
    this.people.clear();
    this.byToken.clear();
    for (const r of people) {
      const details = r.enc ? (JSON.parse(await decryptField(this.keys, r.enc)) as PersonDetails) : {};
      this.people.set(r.id, { id: r.id, name: await decryptField(this.keys, r.nameEncrypted), details, mergedIntoId: r.mergedIntoId, tokens: r.tokens });
    }
    for (const p of this.people.values()) for (const t of p.tokens) this.byToken.set(t, p.id);
    return plain;
  }

  // The live person an id leads to (merges are flattened, so once is enough).
  resolve(id: string): string {
    return this.people.get(id)?.mergedIntoId ?? id;
  }

  nameOf(id: string): string | undefined {
    return this.people.get(this.resolve(id))?.name;
  }

  get(id: string): Person | undefined {
    return this.people.get(id);
  }

  all(): Person[] {
    return [...this.people.values()].map(({ tokens: _t, ...p }) => p);
  }

  // The person a typed name means: found by its token, or made (and sent to
  // the server) when there is none. Null for a name with no letters or digits.
  async idFor(name: string): Promise<string | null> {
    const display = name.trim().replace(/\s+/g, ' ');
    if (!norm(display)) return null;
    const token = await nameToken(this.keys, display);
    const found = this.byToken.get(token);
    if (found) return this.resolve(found);
    const id = this.newId();
    await this.save(id, display, {}, [token]);
    return id;
  }

  private async save(id: string, name: string, details: PersonDetails, tokens: string[]): Promise<void> {
    const clean: PersonDetails = {};
    if (details.first) clean.first = details.first;
    if (details.last) clean.last = details.last;
    if (details.note) clean.note = details.note;
    if (details.aliases?.length) clean.aliases = details.aliases;
    const unique = [...new Set(tokens)];
    await this.server.put(id, {
      nameEncrypted: await encryptField(this.keys, name),
      tokens: unique,
      ...(Object.keys(clean).length ? { enc: await encryptField(this.keys, JSON.stringify(clean)) } : {}),
    });
    const before = this.people.get(id);
    for (const t of before?.tokens ?? []) if (this.byToken.get(t) === id) this.byToken.delete(t);
    this.people.set(id, { id, name, details: clean, tokens: unique });
    for (const t of unique) this.byToken.set(t, id);
  }

  private async tokensFor(name: string, details: PersonDetails): Promise<string[]> {
    return Promise.all([name, ...(details.aliases ?? [])].map((n) => nameToken(this.keys, n)));
  }

  // The old name stays as an AKA, as a rename does for every other record.
  async rename(id: string, name: string): Promise<void> {
    const p = this.live(id);
    const display = name.trim().replace(/\s+/g, ' ');
    if (!norm(display)) throw new Error('A name needs at least one letter or digit.');
    const held = this.byToken.get(await nameToken(this.keys, display));
    if (held && this.resolve(held) !== id) throw new Error(`Another person is already called "${display}". Merge them instead.`);
    const aliases = [...new Set([...(p.details.aliases ?? []), p.name])].filter((a) => norm(a) !== norm(display));
    const details = { ...p.details, aliases };
    await this.save(id, display, details, await this.tokensFor(display, details));
  }

  async setDetails(id: string, patch: Pick<PersonDetails, 'first' | 'last' | 'note'>): Promise<void> {
    const p = this.live(id);
    const details = { ...p.details, ...patch };
    await this.save(id, p.name, details, await this.tokensFor(p.name, details));
  }

  async addAlias(id: string, alias: string): Promise<void> {
    const p = this.live(id);
    const display = alias.trim().replace(/\s+/g, ' ');
    if (!norm(display)) throw new Error('A name needs at least one letter or digit.');
    const held = this.byToken.get(await nameToken(this.keys, display));
    if (held && this.resolve(held) !== id) throw new Error(`Another person is already called "${display}". Merge them instead.`);
    const details = { ...p.details, aliases: [...new Set([...(p.details.aliases ?? []), display])] };
    await this.save(id, p.name, details, await this.tokensFor(p.name, details));
  }

  async removeAlias(id: string, alias: string): Promise<void> {
    const p = this.live(id);
    const details = { ...p.details, aliases: (p.details.aliases ?? []).filter((a) => norm(a) !== norm(alias)) };
    await this.save(id, p.name, details, await this.tokensFor(p.name, details));
  }

  // Fold one person into another. The server repoints events and tokens; the
  // first person's name is kept as an AKA of the second.
  async merge(id: string, into: string): Promise<void> {
    const from = this.live(id);
    const target = this.live(into);
    const details = { ...target.details, aliases: [...new Set([...(target.details.aliases ?? []), from.name, ...(from.details.aliases ?? [])])] };
    await this.server.merge(id, into);
    await this.save(into, target.name, details, [...(await this.tokensFor(target.name, details)), ...from.tokens]);
    await this.load();
  }

  // Plain people (names already on the server from before the vault) become
  // encrypted ones, one at a time, and then the plain ones are erased. A name
  // that already has an encrypted person goes to that person.
  async convertPlain(plain: PlainPerson[]): Promise<void> {
    for (const p of plain.filter((x) => !x.mergedIntoId)) {
      const token = await nameToken(this.keys, p.name);
      let to = this.byToken.get(token);
      if (!to) {
        const details: PersonDetails = {};
        for (const k of ['first', 'last', 'note'] as const) if (typeof p.attrs?.[k] === 'string') details[k] = p.attrs[k] as string;
        // Plain aliases are normalized spellings; they keep working as AKAs.
        if (p.aliases.length) details.aliases = p.aliases;
        to = this.newId();
        await this.save(to, p.name, details, await this.tokensFor(p.name, details));
      }
      await this.server.convert(p.id, this.resolve(to));
    }
    await this.server.finish();
  }

  private live(id: string): Person & { tokens: string[] } {
    const p = this.people.get(this.resolve(id));
    if (!p) throw new Error('No such person.');
    return p;
  }
}

// ---- Events: names on the page, ids on the server -------------------------------

// The event as the page uses it: the people's names back in `companions` and
// their ids in refs. Without the keys (locked) the people are left out and the
// event says so, so the page shows "Vault locked" rather than "no one".
export function hydrateEvent(event: LoggedEvent, book: PeopleBook | null): LoggedEvent {
  if (!event.personIds?.length) return event;
  if (!book) return { ...event, peopleLocked: true };
  const seen = new Set<string>();
  const names: string[] = [];
  const ids: string[] = [];
  for (const raw of event.personIds) {
    const id = book.resolve(raw);
    const name = book.nameOf(id);
    if (!name || seen.has(id)) continue;
    seen.add(id);
    names.push(name);
    ids.push(id);
  }
  const refs = event.refs ?? { venueId: null, placeId: null, seriesId: null, companionIds: [] };
  return { ...event, companions: [...event.companions, ...names], refs: { ...refs, companionIds: [...refs.companionIds, ...ids] } };
}

// A request body that names companions, changed to the people's ids. Throws
// while locked, so a name is never sent in the clear.
export async function dehydrateBody<T extends { companions?: string[] }>(body: T, book: PeopleBook | null): Promise<T & { personIds?: string[] }> {
  const names = body.companions;
  if (!names?.length) return body;
  if (!book) throw new Error('Unlock your vault to change who went.');
  const ids: string[] = [];
  for (const name of names) {
    const id = await book.idFor(name);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return { ...body, companions: [], personIds: ids };
}
