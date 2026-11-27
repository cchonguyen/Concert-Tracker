// Auto-link (docs/specs/series-sync.md, Charlie 2026-11-27: "Link automatically, undoable").
//
// An unlinked event is linked to a shared edition only when exactly one verified edition covers its full start
// date, has the same name (or its series' name or an alias), and has the same venue or no venue on one side.
// The link keeps what the person sees: every shared field they hold that differs from the edition becomes an
// override, what they first typed is kept as `captured`, and `details.autoLinked` records it so Unlink undoes it
// (`unlinkEvent`), after which that edition is never linked to on its own again.
//
// It reads only shared edition headers and the member's own events through their scoped store. No personal field
// leaves the member's store, and no edition is written.
import type { EditionHeader } from '../lineup/types';
import { isVerifiedStatus, type LineupStore } from '../lineup/store/types';
import type { LoggedEvent } from '../events/types';
import { ensureCaptured, resolveEvent } from '../events/inherit';
import { normalizeName, seriesSlugFor } from '../lineup/text';
import { editionCoversDate, subjectOf } from './match';
import { eventSeriesSlug } from '../events/routes';
import { currentBudget } from '../lineup/budget';

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCAN_LIMIT = 5000;
export const AUTO_LINK_ACTOR = 'system:auto-link';
const REASON = 'Same date, name and venue as exactly one verified edition';

type Shared = 'name' | 'startDate' | 'endDate' | 'venue' | 'city' | 'region' | 'country';
const SHARED: Array<{ field: Shared; key: 'name' | 'start_date' | 'end_date' | 'venue' | 'city' | 'region' | 'country' }> = [
  { field: 'name', key: 'name' },
  { field: 'startDate', key: 'start_date' },
  { field: 'endDate', key: 'end_date' },
  { field: 'venue', key: 'venue' },
  { field: 'city', key: 'city' },
  { field: 'region', key: 'region' },
  { field: 'country', key: 'country' },
];
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// Whether the app may link this event on its own at all.
export function isAutoLinkCandidate(e: LoggedEvent): boolean {
  return (
    !e.editionId &&
    !e.deletedAt &&
    e.attendance !== 'missed' &&
    Boolean(text(e.name)) &&
    typeof e.startDate === 'string' &&
    FULL_DATE.test(e.startDate)
  );
}

function namesOf(e: EditionHeader): Set<string> {
  const out = new Set<string>();
  for (const n of [e.name, e.seriesName, ...(e.seriesAliases ?? [])]) {
    const k = n ? normalizeName(n) : '';
    if (k) out.add(k);
  }
  return out;
}

function sameName(event: LoggedEvent, e: EditionHeader): boolean {
  const k = normalizeName(event.name);
  if (k && namesOf(e).has(k)) return true;
  const slug = seriesSlugFor(event.name);
  return Boolean(slug) && subjectOf(e) === slug;
}

function venuesAgree(event: LoggedEvent, e: EditionHeader): boolean {
  const a = normalizeName(event.venue ?? '');
  const b = normalizeName(e.venue ?? '');
  return !a || !b || a === b;
}

// The one edition an event links to on its own, or null (none, or two or more).
export function autoLinkEdition(event: LoggedEvent, headers: EditionHeader[]): EditionHeader | null {
  if (!isAutoLinkCandidate(event)) return null;
  const declined = new Set(event.details?.autoLinkDeclined ?? []);
  const found = headers.filter(
    (e) =>
      isVerifiedStatus(e.status) &&
      !declined.has(e.id) &&
      editionCoversDate(e, event.startDate!).matched &&
      sameName(event, e) &&
      venuesAgree(event, e),
  );
  return found.length === 1 ? found[0] : null;
}

// The event linked to `edition` with nothing on its screen changed: a field it holds that the edition shows
// differently becomes an override. The series follows the shared series (Charlie 2026-11-26).
export function linkedToEdition(event: LoggedEvent, edition: EditionHeader, now: Date): LoggedEvent {
  const base = ensureCaptured(event);
  const draft: LoggedEvent = { ...base, editionId: edition.id, overrides: {} };
  const shown = resolveEvent(draft, edition);
  const overrides: NonNullable<LoggedEvent['overrides']> = {};
  for (const { field, key } of SHARED) {
    const mine = text(base[field]);
    if (mine !== undefined && text(shown[field]) !== mine) overrides[key] = mine;
  }
  const at = now.toISOString();
  return {
    ...draft,
    overrides,
    details: { ...base.details, autoLinked: { editionId: edition.id, at, reason: REASON } },
    updatedAt: at,
  };
}

export interface AutoLinkMember {
  userId: string | null;
  role: string;
  blocked?: boolean;
}

export interface AutoLinkReport {
  members: number;
  linked: number;
  ambiguous: number; // candidates with no single edition (none or several)
}

export interface AutoLinkOptions {
  now: Date;
  budgetLeft?: () => number;
  maxPerMember?: number;
}

const MEMBER_COST = 3; // listEvents, series list (cached), putEvents
function defaultBudgetLeft(): number {
  const b = currentBudget();
  return b ? b.limit - b.reserve - b.used : Number.POSITIVE_INFINITY;
}

// Shared series read once per run, so a member with many links costs a few calls.
function withSeriesCache(store: LineupStore): LineupStore {
  let list: ReturnType<LineupStore['listSeries']> | null = null;
  const all = () => (list ??= store.listSeries({ limit: 500 }));
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'listSeries') return () => all();
      if (prop === 'getSeries') return async (slug: string) => (await all()).find((s) => s.slug === slug) ?? null;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// Links every candidate event of each member (owner included) that matches exactly one verified edition.
// Returns null when the run did nothing.
export async function runAutoLink(service: LineupStore, members: AutoLinkMember[], opts: AutoLinkOptions): Promise<AutoLinkReport | null> {
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const maxPerMember = Math.max(1, opts.maxPerMember ?? 50);
  const report: AutoLinkReport = { members: 0, linked: 0, ambiguous: 0 };
  if (budgetLeft() < 1 + MEMBER_COST) return null;
  const headers = (await service.listEditionHeaders({ limit: SCAN_LIMIT, status: 'verified' })).filter((e) => isVerifiedStatus(e.status));
  if (!headers.length) return null;
  const series = withSeriesCache(service);
  for (const m of members) {
    if (m.blocked || !m.userId) continue;
    if (budgetLeft() < MEMBER_COST) break;
    const scoped = service.forUser?.({ userId: m.userId, role: m.role === 'owner' ? 'owner' : 'member' });
    if (!scoped) continue;
    report.members++;
    const changed: LoggedEvent[] = [];
    for (const e of await scoped.listEvents()) {
      if (changed.length >= maxPerMember) break;
      if (!isAutoLinkCandidate(e)) continue;
      const edition = autoLinkEdition(e, headers);
      if (!edition) {
        report.ambiguous++;
        continue;
      }
      const linked = linkedToEdition(e, edition, opts.now);
      const slug = await eventSeriesSlug(series, linked, edition);
      const { seriesSlug: _old, ...rest } = linked;
      changed.push(slug ? { ...rest, seriesSlug: slug } : rest);
    }
    if (changed.length) {
      await scoped.putEvents(changed);
      report.linked += changed.length;
    }
  }
  return report.linked ? report : null;
}
