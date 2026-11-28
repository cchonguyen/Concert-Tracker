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
import { BudgetExhausted, currentBudget, runReserved } from '../lineup/budget';
import { recordWhoISawTicks, TICK_VERIFY_THRESHOLD, verifyByMemberTicks } from './memberTick';
import { writeEdition } from './editions';
import type { Edition } from '../lineup/types';
import { NOTICE_SETTING, NOTICE_VERSION } from '../auth/routes';
import { ensureDraftEdition } from './draftEdition';

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCAN_LIMIT = 5000;
export const AUTO_LINK_ACTOR = 'system:auto-link';
const REASON = 'Same date, name and venue as exactly one verified edition';
// Cost of one draft edition, worst case (upsert reads, a write, and the link); see runAutoLink.
export const DRAFT_COST = 16;

// The store wraps errors in its own message, so a spent budget is also recognised by its text.
export const isBudgetOut = (err: unknown): boolean =>
  err instanceof BudgetExhausted || (err instanceof Error && /BudgetExhausted|budget exhausted/i.test(err.message));

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

// Contribute back (Charlie 2026-11-27: "If we're both entering in information and information lines up, it
// should be added to shared editions"). Once per linked event, automatic or by tap:
//   - each act the person ticked joins the edition's lineup as a candidate (recordWhoISawTicks: never verified);
//   - the owner's own event fills only the edition's empty venue, city, state, country and end date, the same
//     facts the owner backfill already trusts (backfill.ts), through writeEdition: logged and undoable.
// A member's typed facts never fill a verified edition. Only public facts go in; no personal field is read.
const FILLABLE = ['venue', 'city', 'region', 'country', 'endDate'] as const;
const CONTRIBUTE_REASON = "Filled from the owner's event linked to this edition";

export function editionFilledFrom(edition: Edition, event: LoggedEvent): Edition | null {
  const next: Edition = { ...edition };
  let changed = false;
  for (const f of FILLABLE) {
    const mine = text(event[f]);
    if (mine === undefined || text(edition[f]) !== undefined) continue;
    if (f === 'endDate' && (!FULL_DATE.test(mine) || (edition.startDate && mine < edition.startDate))) continue;
    next[f] = mine;
    changed = true;
  }
  return changed ? next : null;
}

export interface ContributeReport {
  events: number;
  acts: number;
  filled: number;
}

// Cost of one event, worst case: the edition read and one write per new act, plus a fill.
const contributeCost = (e: LoggedEvent) => 4 + 3 * (e.seen ?? []).filter((s) => s.from === 'you').length;

export async function contributeBack(
  service: LineupStore,
  event: LoggedEvent,
  isOwner: boolean,
  now: Date,
  report: ContributeReport,
): Promise<LoggedEvent> {
  if (!event.editionId) return event;
  const edition = await service.getEdition(event.editionId);
  if (edition) {
    const added = await recordWhoISawTicks(service, edition, event.seen ?? []);
    report.acts += added.length;
    if (isOwner) {
      const fresh = added.length ? await service.getEdition(edition.id) : edition;
      const filled = fresh && editionFilledFrom(fresh, event);
      if (filled) {
        await writeEdition(service, { edition: { ...filled, updatedAt: now.toISOString() }, actor: AUTO_LINK_ACTOR, reason: CONTRIBUTE_REASON });
        report.filled++;
      }
    }
  }
  report.events++;
  return { ...event, details: { ...event.details, contributedAt: now.toISOString() } };
}

const TICK_SEP = '\u0000';

// Adds this member's own ticks on a linked event to the run's tally (edition and act key to member ids).
export function tallyTicks(tally: Map<string, Set<string>>, event: LoggedEvent, memberId: string): void {
  if (!event.editionId || event.deletedAt) return;
  for (const s of event.seen ?? []) {
    if (s.from !== 'you' || !s.key) continue;
    const k = `${event.editionId}${TICK_SEP}${s.key}`;
    let who = tally.get(k);
    if (!who) tally.set(k, (who = new Set()));
    who.add(memberId);
  }
}

export interface AutoLinkMember {
  userId: string | null;
  role: string;
  blocked?: boolean;
  // May this member's events feed shared editions (the current notice). Owners always may; unset means look it up.
  canDraft?: boolean;
}

export interface AutoLinkReport {
  members: number;
  linked: number;
  ambiguous: number; // candidates with no single edition (none or several)
  contributed: ContributeReport;
  verifiedByTicks: number; // candidate acts that two or more members ticked, lifted to verified
  drafted: number; // unlinked events given a draft (provisional) shared edition
}

export interface AutoLinkOptions {
  now: Date;
  budgetLeft?: () => number;
  maxPerMember?: number;
}

const MEMBER_COST = 3; // listEvents, series list (cached), putEvents
// The final save: prior rows, the upserts and the activity log. Kept free above the reserve, because edition
// change records already draw on the reserve during the run.
export const SAVE_COST = 6;
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

// Members who accepted the current notice, read once per run (the gate memberBackfill uses). Null when the store
// cannot read settings in bulk; then each member is looked up on their own store.
async function noticedUserIds(store: LineupStore): Promise<Set<string> | null> {
  if (typeof store.listUserSettingsByKeys !== 'function') return null;
  const rows = await store.listUserSettingsByKeys([NOTICE_SETTING]);
  return new Set(
    rows.filter((r) => r.key === NOTICE_SETTING && (r.data as { version?: number } | null)?.version === NOTICE_VERSION).map((r) => r.userId),
  );
}

async function hasNotice(scoped: LineupStore, userId: string | null, noticed: Set<string> | null): Promise<boolean> {
  if (!userId) return false;
  if (noticed) return noticed.has(userId);
  if (typeof scoped.getSetting !== 'function') return false;
  const n = await scoped.getSetting<{ version: number }>(NOTICE_SETTING);
  return n?.version === NOTICE_VERSION;
}

// Events with a seen act the person ticked come first (0), then the rest (1).
const youRank = (e: LoggedEvent) => ((e.seen ?? []).some((s) => s.from === 'you') ? 0 : 1);

// Links every candidate event of each member (owner included) that matches exactly one verified edition.
// Returns null when the run did nothing.
export async function runAutoLink(service: LineupStore, members: AutoLinkMember[], opts: AutoLinkOptions): Promise<AutoLinkReport | null> {
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const maxPerMember = Math.max(1, opts.maxPerMember ?? 50);
  const report: AutoLinkReport = { members: 0, linked: 0, ambiguous: 0, contributed: { events: 0, acts: 0, filled: 0 }, verifiedByTicks: 0, drafted: 0 };
  if (budgetLeft() < 1 + MEMBER_COST) return null;
  const headers = (await service.listEditionHeaders({ limit: SCAN_LIMIT, status: 'verified' })).filter((e) => isVerifiedStatus(e.status));
  const series = withSeriesCache(service);
  const noticed = members.some((m) => m.role !== 'owner' && m.canDraft === undefined) ? await noticedUserIds(service) : null;
  // Who ticked which act on which edition, held in memory for this run only and never stored.
  const ticks = new Map<string, Set<string>>();
  let budgetOut = false;
  for (const m of members) {
    if (budgetOut) break;
    if (m.blocked || !m.userId) continue;
    if (budgetLeft() < MEMBER_COST) break;
    const scoped = service.forUser?.({ userId: m.userId, role: m.role === 'owner' ? 'owner' : 'member' });
    if (!scoped) continue;
    report.members++;
    const changed: LoggedEvent[] = [];
    const unmatched: LoggedEvent[] = [];
    const events = await scoped.listEvents();
    for (const e of events) {
      if (changed.length >= maxPerMember) break;
      if (!isAutoLinkCandidate(e)) continue;
      const edition = autoLinkEdition(e, headers);
      if (!edition) {
        report.ambiguous++;
        unmatched.push(e);
        continue;
      }
      const linked = linkedToEdition(e, edition, opts.now);
      let slug: string | undefined | null;
      try {
        slug = await eventSeriesSlug(series, linked, edition);
      } catch (err) {
        if (!isBudgetOut(err)) throw err;
        budgetOut = true;
        break;
      }
      const { seriesSlug: _old, ...rest } = linked;
      changed.push(slug ? { ...rest, seriesSlug: slug } : rest);
    }
    report.linked += changed.length;
    // Contribute back first: it is what fills a linked event's lineup with its Who I Saw acts, and it is cheap.
    // Events with acts you ticked go first. A spent budget stops the loop; what was done is still saved below.
    const byId = new Map(changed.map((e) => [e.id, e]));
    const contributeAll = async () => {
      const linkedNow = events
        .map((e) => byId.get(e.id) ?? e)
        .filter((e) => e.editionId && !e.deletedAt && !e.details?.contributedAt)
        .sort((a, b) => youRank(a) - youRank(b));
      for (const e of linkedNow) {
        if (budgetOut || budgetLeft() < contributeCost(e) + SAVE_COST) break;
        try {
          byId.set(e.id, await contributeBack(service, e, m.role === 'owner', opts.now, report.contributed));
        } catch (err) {
          if (!isBudgetOut(err)) throw err;
          budgetOut = true;
        }
      }
    };
    await contributeAll();
    // Then unlinked dated events that matched no verified edition get a draft edition (events with Who I Saw acts
    // first), while the budget allows, and the new links contribute their acts. Only for members whose entries may feed shared editions.
    const canDraft = m.role === 'owner' || (m.canDraft ?? (await hasNotice(scoped, m.userId, noticed)));
    if (canDraft && !budgetOut) {
      let drafted = 0;
      const todo = unmatched.filter((e) => !e.details?.draftTriedAt).sort((a, b) => youRank(a) - youRank(b));
      for (const e of todo) {
        if (drafted >= maxPerMember) break;
        if (budgetLeft() < DRAFT_COST + contributeCost(e) + SAVE_COST) break;
        try {
          const d = await ensureDraftEdition(service, e, opts.now);
          if (d) {
            const slug = await eventSeriesSlug(series, d.event, d.edition);
            const { seriesSlug: _old, ...rest } = d.event;
            byId.set(e.id, slug ? { ...rest, seriesSlug: slug } : rest);
            drafted++;
          } else {
            // Not linkable now (several matches, or unlinked before): do not spend the budget on it every run.
            byId.set(e.id, { ...e, details: { ...e.details, draftTriedAt: opts.now.toISOString() } });
          }
        } catch (err) {
          if (isBudgetOut(err)) {
            budgetOut = true;
            break;
          }
          console.warn('draft edition not made', err instanceof Error ? err.name : 'error');
        }
      }
      report.drafted += drafted;
    }
    await contributeAll();
    // The save may use the budget's reserve: it must follow the shared writes already made.
    if (byId.size) await runReserved(() => scoped.putEvents([...byId.values()]));
    for (const e of events.map((x) => byId.get(x.id) ?? x)) tallyTicks(ticks, e, m.userId);
  }
  for (const [k, who] of ticks) {
    if (who.size < TICK_VERIFY_THRESHOLD) continue;
    if (budgetLeft() < 4) break;
    const [editionId, artistKey] = k.split(TICK_SEP);
    if (await verifyByMemberTicks(service, editionId, artistKey)) report.verifiedByTicks++;
  }
  return report.linked || report.drafted || report.contributed.events || report.verifiedByTicks ? report : null;
}
