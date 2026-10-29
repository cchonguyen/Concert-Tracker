import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import type { LineupStore } from '../lineup/store/types';
import { isCiphertext, VAULT_SETTING } from '../auth/vault';
import { EntityIntegrityError } from './integrity';
import type { Entity, EntityAlias, HistoryEntry } from './types';

// /api/people: a member's people once their vault is on. A person's name is
// encrypted in the browser, so the server holds an opaque record, the tokens
// that let a typed name find it (HMAC of the normalized name, hex), and the
// events that list the person by id. It can merge, repoint and delete records
// without ever reading a name. Plain people from before the vault are turned
// into encrypted ones by /people/convert and then erased.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_TOKENS = 50;

class PeopleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const bad = (message: string, status: 400 | 404 | 409 = 400): never => {
  throw new PeopleError(message, status);
};

async function requireVault(store: LineupStore): Promise<void> {
  if (!(await store.getSetting(VAULT_SETTING))) bad('Turn on your vault before saving people.', 409);
}

const tokensOf = (aliases: EntityAlias[], id: string) => aliases.filter((a) => a.entityId === id && a.kind === 'person').map((a) => a.aliasNormalized);

export interface PersonView {
  id: string;
  nameEncrypted: string;
  enc?: string; // encrypted details (first and last name, a note)
  mergedIntoId?: string;
  tokens: string[];
}

export function peopleRouter(store: LineupStore): Router {
  const router = Router();
  const handle =
    (fn: (req: any) => Promise<unknown>) =>
    async (req: any, res: Response) => {
      try {
        res.json(await fn(req));
      } catch (err) {
        if (err instanceof PeopleError) return res.status(err.status).json({ error: err.message });
        if (err instanceof EntityIntegrityError) return res.status(409).json({ error: err.message });
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    };

  // Encrypted people with their tokens, and the plain people still to convert
  // (their names are already on the server, from before the vault).
  router.get(
    '/people',
    handle(async () => {
      const [entities, aliases] = await Promise.all([store.listEntities(), store.listEntityAliases()]);
      const people: PersonView[] = entities
        .filter((e) => e.kind === 'person' && e.nameEncrypted)
        .map((e) => ({
          id: e.id,
          nameEncrypted: e.nameEncrypted!,
          ...(typeof e.attrs.enc === 'string' ? { enc: e.attrs.enc } : {}),
          ...(e.mergedIntoId ? { mergedIntoId: e.mergedIntoId } : {}),
          tokens: tokensOf(aliases, e.id),
        }));
      const plain = entities
        .filter((e) => e.kind === 'person' && !e.nameEncrypted)
        .map((e) => ({ id: e.id, name: e.name, attrs: e.attrs, mergedIntoId: e.mergedIntoId, aliases: tokensOf(aliases, e.id) }));
      return { people, plain };
    }),
  );

  // Make or change a person. The id is the browser's random one.
  router.put(
    '/people/:id',
    handle(async (req) => {
      await requireVault(store);
      const id = String(req.params.id);
      const { nameEncrypted, enc, tokens } = req.body ?? {};
      if (!UUID.test(id)) bad('A person id is a UUID.');
      if (!isCiphertext(nameEncrypted)) bad('A person\'s name must be encrypted in the browser.');
      if (enc !== undefined && enc !== null && !isCiphertext(enc)) bad('Details must be encrypted in the browser.');
      if (!Array.isArray(tokens) || tokens.length > MAX_TOKENS || tokens.some((t) => typeof t !== 'string' || !TOKEN.test(t))) {
        bad('Name tokens are 64-character hex strings.');
      }
      const entities = await store.listEntities();
      const found = entities.find((e) => e.id === id);
      if (found && (found.kind !== 'person' || !found.nameEncrypted)) bad('That id belongs to another record.', 409);
      if (found?.mergedIntoId) bad('That person was merged into another.', 409);
      const at = new Date().toISOString();
      const person: Entity = {
        id,
        kind: 'person',
        name: '',
        nameNormalized: '',
        nameEncrypted,
        attrs: enc ? { enc } : {},
        createdAt: found?.createdAt ?? at,
        updatedAt: at,
      };
      await store.putEntities([person]);
      const unique = [...new Set<string>(tokens)];
      await store.replaceEntityAliases([id], unique.map((t) => ({ entityId: id, kind: 'person' as const, aliasNormalized: t })));
      return { id };
    }),
  );

  // Fold one person into another: events that list the first now list the
  // second, and the first's tokens find the second. Names are not read.
  router.post(
    '/people/:id/merge',
    handle(async (req) => {
      const from = String(req.params.id);
      const into = String(req.body?.into ?? '');
      if (from === into) bad('A person cannot be merged into themselves.');
      const [entities, aliases] = await Promise.all([store.listEntities(), store.listEntityAliases()]);
      const source = entities.find((e) => e.id === from && e.kind === 'person' && e.nameEncrypted);
      const target = entities.find((e) => e.id === into && e.kind === 'person' && e.nameEncrypted);
      if (!source || !target) bad('Both must be people in your vault.', 404);
      if (source!.mergedIntoId || target!.mergedIntoId) bad('One of them was already merged.', 409);
      const at = new Date().toISOString();
      const events = (await store.listEvents()).filter((e) => e.personIds?.includes(from));
      await store.putEvents(
        events.map((e) => ({ ...e, personIds: [...new Set(e.personIds!.map((id) => (id === from ? into : id)))], updatedAt: at })),
      );
      await store.putEntities([{ ...source!, mergedIntoId: into, updatedAt: at }]);
      const moved = [...new Set([...tokensOf(aliases, into), ...tokensOf(aliases, from)])];
      await store.replaceEntityAliases([from, into], moved.map((t) => ({ entityId: into, kind: 'person' as const, aliasNormalized: t })));
      return { merged: from, into, events: events.length };
    }),
  );

  // Turn a plain person (name already on the server) into an encrypted one
  // the browser just made, then erase the plain one: its events, links and
  // history entries move or go, so no readable name is left.
  router.post(
    '/people/:id/convert',
    handle(async (req) => {
      await requireVault(store);
      const from = String(req.params.id);
      const to = String(req.body?.to ?? '');
      const entities = await store.listEntities();
      const plain = entities.find((e) => e.id === from && e.kind === 'person' && !e.nameEncrypted);
      const target = entities.find((e) => e.id === to && e.kind === 'person' && e.nameEncrypted && !e.mergedIntoId);
      if (!plain) bad('That is not a plain person of yours.', 404);
      if (!target) bad('Make the encrypted person first.', 404);
      const at = new Date().toISOString();

      // Events: the name leaves `companions`, the id joins `personIds`.
      const events = (await store.listEvents()).filter((e) => e.refs?.companionIds.includes(from) || e.personIds?.includes(from));
      await store.putEvents(
        events.map((e) => {
          const ids = e.refs?.companionIds ?? [];
          const keep = e.companions.filter((_, i) => ids[i] !== from);
          const keptIds = ids.filter((id) => id !== from);
          return {
            ...e,
            companions: keep,
            refs: e.refs ? { ...e.refs, companionIds: keptIds } : e.refs,
            personIds: [...new Set([...(e.personIds ?? []).map((id) => (id === from ? to : id)), to])],
            updatedAt: at,
          };
        }),
      );

      // Links the plain person had (who introduced me to an artist) move over.
      const links = (await store.listEntityLinks()).filter((l) => l.fromId === from || l.toId === from);
      if (links.length) await store.addEntityLinks(links.map((l) => ({ ...l, fromId: l.fromId === from ? to : l.fromId, toId: l.toId === from ? to : l.toId })));

      // History entries that hold a person's name or an event's companions.
      const history = await store.listEntityHistory(10_000);
      const holdsNames = (h: HistoryEntry) =>
        [...h.entities.before, ...h.entities.after].some((e) => e.kind === 'person') ||
        h.events.some((ev) => 'companions' in ev.before || 'companions' in ev.after);
      await store.deleteEntityHistory(history.filter(holdsNames).map((h) => h.id));

      await store.deleteEntities([from]);
      const entry: HistoryEntry = {
        id: randomUUID(),
        operation: 'details',
        summary: 'A person was moved into your vault',
        sourceEntityId: to,
        entities: { before: [], after: [] },
        touched: [],
        aliases: { before: [], after: [] },
        links: { before: [], after: [] },
        events: [],
        createdAt: at,
      };
      await store.putEntityHistory(entry);
      return { converted: from, to, events: events.length };
    }),
  );

  // After every live plain person was converted: erase what is left of the
  // plain ones (merged-away records and their spellings) so no readable name
  // stays. Refused while a live plain person still has events.
  router.post(
    '/people/finish',
    handle(async () => {
      await requireVault(store);
      const entities = await store.listEntities();
      const plain = entities.filter((e) => e.kind === 'person' && !e.nameEncrypted);
      const live = plain.filter((e) => !e.mergedIntoId);
      const events = await store.listEvents();
      const waiting = live.filter((e) => events.some((ev) => ev.refs?.companionIds.includes(e.id)));
      if (waiting.length) bad(`${waiting.length} people still have their names in the clear. Convert them first.`, 409);
      await store.deleteEntities(plain.map((e) => e.id));
      return { erased: plain.length };
    }),
  );

  return router;
}
