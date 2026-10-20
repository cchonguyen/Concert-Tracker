import {
  BlocklistEntry,
  CandidateFacts,
  CandidateLineup,
  CandidatePerformer,
  EditionFacts,
  FactClaim,
  LookupInput,
  PerformerClaim,
  SourceStat,
  SourceType,
} from './types';
import { domainOf, normalizeName } from './text';

// Starting reliability per source before any review history exists. The
// measured accept/reject rate from your reviews pulls these toward reality.
export const SOURCE_PRIOR: Record<SourceType, number> = {
  setlistfm: 0.95,
  promoter: 0.9,
  wayback: 0.88,
  clashfinder: 0.85,
  ticketmaster: 0.8,
  musicbrainz: 0.7,
  discovered: 0.65,
  email: 0.9,
  user: 1,
};

export const DEFAULT_PRIORITY: SourceType[] = [
  'user',
  'promoter',
  'wayback',
  'clashfinder',
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

// Independent sources agreeing raise confidence: 1 - prod(1 - r).
export function combineConfidence(reliabilities: number[]): number {
  return 1 - reliabilities.reduce((acc, r) => acc * (1 - r), 1);
}

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

  const performers: CandidatePerformer[] = [];
  for (const [key, claims] of groups) {
    const byPriority = [...claims].sort(
      (a, b) => priority.indexOf(a.sourceType) - priority.indexOf(b.sourceType),
    );
    const aliasName = ctx.aliases[key];
    const types = [...new Set(claims.map((c) => c.sourceType))];
    const confidence = combineConfidence(types.map((t) => sourceReliability(t, ctx.seriesSlug, ctx.stats)));
    const sourceUrls = new Set<string>();
    performers.push({
      key,
      name: aliasName ?? byPriority[0].name.trim(),
      mbid: claims.find((c) => c.mbid)?.mbid,
      days: [...new Set(claims.map((c) => c.day).filter((d): d is string => Boolean(d)))].sort(),
      stages: [...new Set(claims.map((c) => c.stage).filter((s): s is string => Boolean(s)))],
      status: claims.some((c) => c.evidence === 'performed') ? 'performed' : 'billed',
      confidence: Math.round(confidence * 1000) / 1000,
      flagged:
        confidence < FLAG_BELOW ||
        (discoveredPages.size >= 2 &&
          claims.every((c) => c.sourceType === 'discovered') &&
          new Set(claims.map((c) => c.sourceUrl)).size === 1),
      sources: byPriority
        .filter((c) => {
          const k = `${c.sourceType}|${c.sourceUrl}`;
          if (sourceUrls.has(k)) return false;
          sourceUrls.add(k);
          return true;
        })
        .map((c) => ({
          sourceType: c.sourceType,
          sourceUrl: c.sourceUrl,
          quotedSpan: c.quotedSpan,
          evidence: c.evidence,
          extractor: c.extractor,
        })),
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

export function appendFacts(target: Partial<EditionFacts>, extra: Partial<EditionFacts>): Partial<EditionFacts> {
  const out: Partial<EditionFacts> = { ...target };
  for (const [k, v] of Object.entries(extra) as [keyof EditionFacts, FactClaim[]][]) {
    if (v?.length) out[k] = [...(out[k] ?? []), ...v];
  }
  return out;
}
