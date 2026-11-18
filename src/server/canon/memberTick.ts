// Member tick as candidate (auto-verify slice 5, docs/auto-verify-spec.md).
// A person's "Who I Saw" act on an event linked to a shared edition adds that act to the edition's lineup as a
// `candidate`, sourced "your entry" with the typed name as the quoted span. The shared row holds no user id, no
// event id and no personal field. The change record carries the system actor and a fixed reason only.
// A member's tick never verifies an act on its own (autoVerify.ts: member_entry is not a usable source).
import type { LineupStore } from '../lineup/store/types';
import type { EditionPerformance, Edition } from '../lineup/types';
import type { SeenAct } from '../events/types';
import { MEMBER_TICK_KEY, writeEdition } from './editions';

export const MEMBER_TICK_EXTRACTOR = 'your entry';

export interface MemberTickInput {
  editionId: string;
  artistKey: string;
  artistName: string;
  actor: string; // 'member:entry'
  reason: string; // fixed text, never personal
}

export type MemberTickResult =
  | { ok: true; changeId: string | null }
  | { ok: false; reason: 'unknown' | 'already_listed' | 'empty' };

export async function recordMemberTick(store: LineupStore, input: MemberTickInput): Promise<MemberTickResult> {
  const name = input.artistName.trim();
  if (!name || !input.artistKey) return { ok: false, reason: 'empty' };
  const edition = await store.getEdition(input.editionId);
  if (!edition) return { ok: false, reason: 'unknown' };
  if (edition.performances.some((p) => p.artistKey === input.artistKey)) return { ok: false, reason: 'already_listed' };
  const act: EditionPerformance = {
    artistKey: input.artistKey,
    name,
    days: [],
    stages: [],
    status: 'billed',
    confidence: 0,
    verification: 'candidate',
    sources: [
      {
        sourceType: 'user',
        sourceUrl: '',
        quotedSpan: name,
        evidence: 'billed',
        extractor: MEMBER_TICK_EXTRACTOR,
      },
    ],
  };
  const next = { ...edition, performances: [...edition.performances, act], updatedAt: new Date().toISOString() };
  const written = await writeEdition(store, {
    edition: next,
    actor: input.actor,
    reason: input.reason,
    extra: { after: { [MEMBER_TICK_KEY]: input.artistKey } },
  });
  return { ok: true, changeId: written.change?.id ?? null };
}

// Who I Saw on a linked event: each act you saw (not a lineup-sourced act) that the edition does not list yet
// becomes a candidate. Acts already listed are left alone, so a tick never changes an existing act's status.
// Sequential writes keep the edition's change log in order. Returns the keys it added.
export async function recordWhoISawTicks(store: LineupStore, edition: Edition, seen: SeenAct[]): Promise<string[]> {
  const listed = new Set(edition.performances.map((p) => p.artistKey));
  const added: string[] = [];
  for (const s of seen) {
    if (s.from !== 'you' || !s.key || listed.has(s.key)) continue;
    const r = await recordMemberTick(store, {
      editionId: edition.id,
      artistKey: s.key,
      artistName: s.name,
      actor: 'member:entry',
      reason: 'Member tick from Who I Saw',
    });
    if (r.ok) {
      listed.add(s.key);
      added.push(s.key);
    }
  }
  return added;
}
