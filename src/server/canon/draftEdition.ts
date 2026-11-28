// Draft edition for an unlinked dated event (docs/specs/who-i-saw-lineup.md).
//
// The event's typed name, full start date and typed venue, city and state become a `provisional` shared edition,
// the same shape a member entry already creates (persistOwnEntry, src/server/events/details.ts). The event is then
// linked to it, so its Who I Saw acts can join the shared lineup as candidates. No personal field, user id or event
// id goes into the edition. Unlink declines the edition (`details.autoLinkDeclined`), so it is not linked again.
import type { Edition } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import type { LoggedEvent } from '../events/types';
import { seriesSlugFor } from '../lineup/text';
import { upsertOccurrence } from './match';
import { linkedToEdition } from './autoLink';

export const DRAFT_LINK_REASON = 'Draft edition from your entry';
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function ensureDraftEdition(
  store: LineupStore,
  event: LoggedEvent,
  now: Date,
): Promise<{ event: LoggedEvent; edition: Edition } | null> {
  if (event.editionId || event.deletedAt || event.attendance === 'missed') return null;
  if (!event.name?.trim() || typeof event.startDate !== 'string' || !FULL_DATE.test(event.startDate)) return null;

  const typed = (f: 'venue' | 'city' | 'region') => (event.sources[f]?.sourceType === 'user' ? event[f] : undefined);
  const r = await upsertOccurrence(store, {
    name: event.name,
    startDate: event.startDate,
    ...(event.endDate && event.sources.endDate?.sourceType === 'user' ? { endDate: event.endDate } : {}),
    venue: typed('venue'),
    city: typed('city'),
    region: typed('region'),
    subjectKey: seriesSlugFor(event.name),
    externalIds: [],
    trust: 'provisional',
    actor: 'member:entry',
    reason: 'Member entry',
  });
  if (!(r.action === 'created' || r.action === 'updated' || r.action === 'unchanged') || !r.edition) return null;

  const found = r.edition;
  // The person unlinked this edition before: do not link it again on their behalf.
  if (event.details?.autoLinkDeclined?.includes(found.id)) return null;

  const linked = linkedToEdition(event, found, now);
  const reason = DRAFT_LINK_REASON;
  const draft: LoggedEvent = {
    ...linked,
    details: { ...linked.details, autoLinked: { editionId: found.id, at: now.toISOString(), reason } },
  };
  const edition = Array.isArray(found.performances) ? found : ((await store.getEdition(found.id)) ?? found);
  return { event: draft, edition };
}
