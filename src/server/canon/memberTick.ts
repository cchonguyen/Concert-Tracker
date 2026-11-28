// Member tick as candidate (auto-verify, docs/auto-verify-spec.md).
// A person's "Who I Saw" act on an event linked to a shared edition adds that act to the edition's lineup as a
// `candidate`, sourced "your entry" with the typed name as the quoted span. The shared row holds no user id, no
// event id and no personal field. The change record carries the system actor and a fixed reason only.
// One member's tick never verifies an act (autoVerify.ts: member_entry is not a usable source); two members' do, below.
import type { LineupStore } from '../lineup/store/types';
import type { EditionPerformance, Edition } from '../lineup/types';
import type { SeenAct } from '../events/types';
import { AUTO_VERIFY_KEY, AUTO_VERIFY_PREVIOUS_KEY, MEMBER_TICK_KEY, writeEdition } from './editions';

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

// Two members verify an act (Charlie 2026-11-27, docs/specs/series-sync.md Rule 1c). The hourly run counts, in memory
// only, how many different members ticked each act on each shared edition; nothing about who ticked what is stored.
// When two or more did, a candidate act is lifted to verified, recorded like an auto-verify so the same undo puts it
// back to candidate. An act the owner put back (an undone member-verify change) is left alone from then on.
export const TICK_VERIFY_ACTOR = 'system:member-verify';
export const TICK_VERIFY_THRESHOLD = 2;
export const TICK_VERIFY_REASON = 'two members ticked this act';

export async function verifyByMemberTicks(store: LineupStore, editionId: string, artistKey: string): Promise<boolean> {
  const edition = await store.getEdition(editionId);
  const act = edition?.performances.find((p) => p.artistKey === artistKey);
  if (!edition || !act || (act.verification ?? 'verified') === 'verified') return false;
  const changes = await store.listEditionChanges(editionId);
  const undone = changes.some((c) => c.actor === TICK_VERIFY_ACTOR && !!c.undoneAt && (c.after as Record<string, unknown> | null)?.[AUTO_VERIFY_KEY] === artistKey);
  if (undone) return false;
  const performances = edition.performances.map((p) => (p.artistKey === artistKey ? { ...p, verification: 'verified' as const } : p));
  await writeEdition(store, {
    edition: { ...edition, performances, updatedAt: new Date().toISOString() },
    actor: TICK_VERIFY_ACTOR,
    reason: TICK_VERIFY_REASON,
    extra: { before: { [AUTO_VERIFY_KEY]: artistKey, [AUTO_VERIFY_PREVIOUS_KEY]: 'candidate' }, after: { [AUTO_VERIFY_KEY]: artistKey } },
  });
  return true;
}
