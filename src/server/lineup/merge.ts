import {
  BlocklistEntry,
  CandidateFacts,
  CandidateLineup,
  CandidatePerformer,
  CandidateSource,
  EditionFacts,
  FactClaim,
  LookupInput,
  PerformerClaim,
  SetTime,
  SourceStat,
  SourceType,
} from './types';
import { domainOf, normalizeName } from './text';

// Starting reliability per source before any review history exists. The
// measured accept/reject rate from your reviews pulls these toward reality.
// Clashfinder's per-edition lineups have proved more accurate than promoter
// pages, which are overwritten for the next edition or list other events of
// the same brand (Sun Soaked 2026).
export const SOURCE_PRIOR: Record<SourceType, number> = {
  setlistfm: 0.95,
  clashfinder: 0.93,
  ticketmaster: 0.8,
  promoter: 0.75,
  wayback: 0.72,
  musicbrainz: 0.7,
  discovered: 0.6,
  email: 0.9,
  user: 1,
};

export const DEFAULT_PRIORITY: SourceType[] = [
  'user',
  'clashfinder',
  'promoter',
  'wayback',
  'ticketmaster',
  'setlistfm',
  'discovered',
  'musicbrainz',
];

const PRIOR_WEIGHT = 10;
export const FLAG_BELOW = 0.6;
export const BLOCKLIST_THRESHOLD = 2;

export function sourceReliability(type: SourceType, seriesSlug: string, stats: SourceStat[]): number {
  const stat =
    stats.find((s) => s.sourceType === type && s.scope === seriesSlug) ??
    stats.find((s) => s.sourceType === type && s.scope === '*');
  const prior = SOURCE_PRIOR[type];
  const a = prior * PRIOR_WEIGHT + (stat?.accepted ?? 0);
  const b = (1 - prior) * PRIOR_WEIGHT + (stat?.rejected ?? 0);
  return a / (a + b);
}

// Independent sources agreeing raise confidence: 1 - prod(1 - r). A source
// that gave a full lineup for the edition and leaves the act out disagrees:
// each one scales the result by (1 - DISSENT_WEIGHT * r), so the more
// accurate the source that leaves it out, the lower the act ends up.
export function combineConfidence(reliabilities: number[], dissent: number[] = []): number {
  const agree = 1 - reliabilities.reduce((acc, r) => acc * (1 - r), 1);
  return dissent.reduce((acc, r) => acc * (1 - DISSENT_WEIGHT * r), agree);
}

// Under half weight: a full lineup can still miss a late addition, so an act
// only Clashfinder lists stays above the flag line when a promoter page
// leaves it out, while one only a promoter page lists drops below it when
// Clashfinder leaves it out.
export const DISSENT_WEIGHT = 0.4;

// Sources that publish a whole lineup, so an act missing from them means
// something. Listings (Ticketmaster), setlists and search pages often name
// only some acts, so their silence says nothing.
export const FULL_LINEUP_SOURCES: SourceType[] = ['clashfinder', 'promoter', 'wayback'];
export const FULL_LINEUP_MIN_ACTS = 5;

export function isBlocked(name: string, sourceUrl: string, blocklist: BlocklistEntry[]): boolean {
  const n = normalizeName(name);
  const domain = domainOf(sourceUrl);
  return blocklist.some(
    (b) => b.rejections >= BLOCKLIST_THRESHOLD && b.normalized === n && (b.domain === domain || b.domain === '*'),
  );
}

export function canonicalName(name: string, aliases: Record<string, string>): string {
  return aliases[normalizeName(name)] ?? name.trim();
}

function pickFact(
  userValue: string | undefined,
  claims: FactClaim[] | undefined,
  priority: SourceType[],
): { value?: string; sources: FactClaim[] } {
  const sources = [...(claims ?? [])].sort(
    (a, b) => priority.indexOf(a.sourceType) - priority.indexOf(b.sourceType),
  );
  return { value: userValue || sources[0]?.value, sources };
}

export function mergeFacts(input: LookupInput, facts: Partial<EditionFacts>, priority: SourceType[]): CandidateFacts {
  const name = pickFact(undefined, facts.name, priority);
  const startDate = pickFact(input.startDate, facts.startDate, priority);
  const endDate = pickFact(input.endDate, facts.endDate, priority);
  const venue = pickFact(input.venue, facts.venue, priority);
  const city = pickFact(input.city, facts.city, priority);
  const country = pickFact(input.country, facts.country, priority);
  return {
    name: input.eventName.trim() || name.value,
    startDate: startDate.value,
    endDate: endDate.value,
    venue: venue.value,
    city: city.value,
    country: country.value,
    sources: {
      name: name.sources,
      startDate: startDate.sources,
      endDate: endDate.sources,
      venue: venue.sources,
      city: city.sources,
      country: country.sources,
    },
  };
}

export interface MergeContext {
  input: LookupInput;
  editionKey: string;
  seriesSlug: string;
  facts: Partial<EditionFacts>;
  claims: PerformerClaim[];
  aliases: Record<string, string>;
  blocklist: BlocklistEntry[];
  stats: SourceStat[];
  priority?: SourceType[];
}

// One source entry per page, carrying every set that page times for the act
// (an act can play twice: two stages, or both weekends).
function sourcesOf(claims: PerformerClaim[]): CandidateSource[] {
  const bySource = new Map<string, CandidateSource>();
  for (const c of claims) {
    const k = `${c.sourceType}|${c.sourceUrl}`;
    let src = bySource.get(k);
    if (!src) {
      src = { sourceType: c.sourceType, sourceUrl: c.sourceUrl, quotedSpan: c.quotedSpan, evidence: c.evidence, extractor: c.extractor };
      bySource.set(k, src);
    }
    if (c.startTime || c.endTime) {
      const set: SetTime = { day: c.day, stage: c.stage, start: c.startTime, end: c.endTime };
      const same = (x: SetTime) => x.start === set.start && x.stage === set.stage;
      if (!src.sets?.some(same)) src.sets = [...(src.sets ?? []), set];
    }
  }
  return [...bySource.values()];
}

export function mergeLineup(ctx: MergeContext): CandidateLineup {
  const priority = ctx.priority?.length ? ctx.priority : DEFAULT_PRIORITY;
  const groups = new Map<string, PerformerClaim[]>();
  let dropped = 0;

  for (const claim of ctx.claims) {
    if (isBlocked(claim.name, claim.sourceUrl, ctx.blocklist)) {
      dropped += 1;
      continue;
    }
    const key = normalizeName(canonicalName(claim.name, ctx.aliases));
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(claim);
    groups.set(key, group);
  }

  // Pages found by web search are only as good as their agreement: an
  // aggregator page can list other events' artists verbatim. When several
  // such pages were read, an act backed by just one of them needs a look.
  const discoveredPages = new Set(ctx.claims.filter((c) => c.sourceType === 'discovered').map((c) => c.sourceUrl));

  // Which sources gave a full lineup for this edition.
  const actsBySource = new Map<SourceType, Set<string>>();
  for (const [key, claims] of groups) {
    for (const c of claims) actsBySource.set(c.sourceType, (actsBySource.get(c.sourceType) ?? new Set()).add(key));
  }
  const fullLineups = FULL_LINEUP_SOURCES.filter((t) => (actsBySource.get(t)?.size ?? 0) >= FULL_LINEUP_MIN_ACTS);

  const performers: CandidatePerformer[] = [];
  for (const [key, claims] of groups) {
    const byPriority = [...claims].sort(
      (a, b) => priority.indexOf(a.sourceType) - priority.indexOf(b.sourceType),
    );
    const aliasName = ctx.aliases[key];
    const types = [...new Set(claims.map((c) => c.sourceType))];
    const missingFrom = fullLineups.filter((t) => !types.includes(t));
    const reliability = (t: SourceType) => sourceReliability(t, ctx.seriesSlug, ctx.stats);
    const confidence = combineConfidence(types.map(reliability), missingFrom.map(reliability));
    performers.push({
      key,
      name: aliasName ?? byPriority[0].name.trim(),
      mbid: claims.find((c) => c.mbid)?.mbid,
      days: [...new Set(claims.map((c) => c.day).filter((d): d is string => Boolean(d)))].sort(),
      stages: [...new Set(claims.map((c) => c.stage).filter((s): s is string => Boolean(s)))],
      status: claims.some((c) => c.evidence === 'performed') ? 'performed' : 'billed',
      billing: agreedBilling(claims),
      confidence: Math.round(confidence * 1000) / 1000,
      missingFrom: missingFrom.length ? missingFrom : undefined,
      flagged:
        confidence < FLAG_BELOW ||
        (discoveredPages.size >= 2 &&
          claims.every((c) => c.sourceType === 'discovered') &&
          new Set(claims.map((c) => c.sourceUrl)).size === 1),
      sources: sourcesOf(byPriority),
    });
  }

  performers.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  return {
    editionKey: ctx.editionKey,
    cached: false,
    facts: mergeFacts(ctx.input, ctx.facts, priority),
    performers,
    droppedCount: dropped,
  };
}

// A role only when every claim that states one states the same one.
function agreedBilling(claims: PerformerClaim[]): PerformerClaim['billing'] {
  const roles = new Set(claims.map((c) => c.billing).filter(Boolean));
  return roles.size === 1 ? [...roles][0] : undefined;
}

export function appendFacts(target: Partial<EditionFacts>, extra: Partial<EditionFacts>): Partial<EditionFacts> {
  const out: Partial<EditionFacts> = { ...target };
  for (const [k, v] of Object.entries(extra) as [keyof EditionFacts, FactClaim[]][]) {
    if (v?.length) out[k] = [...(out[k] ?? []), ...v];
  }
  return out;
}
