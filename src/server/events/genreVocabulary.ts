// The loose-match key and the genre resolver (docs/archive/genre-vocabulary.md
// sections 1, 3 and 5). Pure and free of server imports: the browser uses it too.
// It never joins different words: no stemming, no dropped words, no "&" to "and",
// no closeness matching. Those joins are the owner's, as aliases.

import type {
  ArtistGenres,
  GenreCollision,
  GenreLevel,
  GenreMapEntry,
  GenreRelation,
  GenreShare,
  GenreVocabulary,
  ResolvedGenre,
  VocabGenre,
} from './genreTypes';

export const NOT_GROUPED = 'Not grouped';
export const GENRE_NEEDS_LETTER = 'A genre needs a letter or a number.';

const LEVELS: readonly GenreLevel[] = ['genre', 'family', 'macro'];
const TIERS = ['specific', 'umbrella_fallback'];
const RELATION_TYPES = ['secondary_parent', 'adjacent', 'derived_from'];
const RELATION_ORIGINS = ['curated', 'artist_cooccur', 'lineup_cooccur'];

// Families and macros are rows of the same vocabulary. Their keys never collide with a
// genre key, because genreKey never makes a colon.
export function familyKey(name: string): string {
  return 'family:' + genreKey(name);
}

export function macroKey(name: string): string {
  return 'macro:' + genreKey(name);
}

// A missing level means a genre (every row written before migration 0063).
export function levelOf(g: Pick<VocabGenre, 'level'>): GenreLevel {
  return g.level ?? 'genre';
}

// Accents dropped, lower case, and every character that is not a letter or a digit
// removed. An empty key means the style has no letter or digit and is refused.
export function genreKey(style: string): string {
  return style
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function isValidGenreName(style: string): boolean {
  return genreKey(style) !== '';
}

const EMPTY_VOCAB: GenreVocabulary = { genres: [] };

// Shared rows only: a member's own additions never count toward spelling or group.
function sharedRows(rows: ArtistGenres[]): ArtistGenres[] {
  return rows.filter((r) => r.source !== 'added');
}

// The most counted value, ties broken by the first alphabetically.
function mostCounted(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && best !== undefined && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function bump(m: Map<string, Map<string, number>>, key: string, value: string, by = 1): void {
  let inner = m.get(key);
  if (!inner) m.set(key, (inner = new Map()));
  inner.set(value, (inner.get(value) ?? 0) + by);
}

export interface GenreResolver {
  resolve(style: string): ResolvedGenre;
  groups: string[]; // the distinct parents of the genre map
  hasTaxonomy: boolean; // the vocabulary has at least one macro: family and macro are then shown
}

// Builds the indexes once; resolve() then works for any stored or typed spelling.
export function genreResolver(
  vocab: GenreVocabulary | undefined,
  map: GenreMapEntry[],
  rows: ArtistGenres[] = [],
): GenreResolver {
  const v = vocab ?? EMPTY_VOCAB;
  const byKey = new Map<string, VocabGenre>();
  for (const g of v.genres) byKey.set(g.key, g);
  const aliasTo = new Map<string, string>();
  // Only genres take aliases: a spelling never resolves to a family or a macro.
  for (const g of v.genres) {
    if (levelOf(g) !== 'genre') continue;
    for (const a of g.aliases) if (!byKey.has(a.key)) aliasTo.set(a.key, g.key);
  }
  const target = (k: string): string => (byKey.has(k) ? k : aliasTo.get(k) ?? k);

  const groupByKey = new Map<string, string>();
  for (const m of map) {
    const k = genreKey(m.parent);
    if (k && !groupByKey.has(k)) groupByKey.set(k, m.parent);
  }
  const groups = [...new Set(map.map((m) => m.parent))].sort();

  // Genre map: spellings and parents by the style's own key.
  const mapSpelling = new Map<string, Map<string, number>>();
  const mapParent = new Map<string, Map<string, number>>();
  for (const m of map) {
    const k = genreKey(m.style);
    if (!k) continue;
    bump(mapSpelling, k, m.style.trim());
    bump(mapParent, k, m.parent);
  }

  // Shared rows: spellings by the style's own key (one per artist), parents by the
  // resolved genre, counted only when they are one of the map's groups.
  const rowSpelling = new Map<string, Map<string, number>>();
  const rowParent = new Map<string, Map<string, number>>();
  for (const r of sharedRows(rows)) {
    const seenSpelling = new Set<string>();
    const seenParent = new Set<string>();
    for (const s of r.genres) {
      const name = s.style.trim();
      const k = genreKey(name);
      if (!k) continue;
      if (!seenSpelling.has(name)) {
        seenSpelling.add(name);
        bump(rowSpelling, k, name);
      }
      const group = groupByKey.get(genreKey(s.parent));
      const t = target(k);
      if (group && !seenParent.has(`${t}\u0000${group}`)) {
        seenParent.add(`${t}\u0000${group}`);
        bump(rowParent, t, group);
      }
    }
  }

  const shownSpelling = (k: string, typed: string): string => {
    const fromMap = mapSpelling.get(k);
    if (fromMap) return mostCounted(fromMap)!;
    const fromRows = rowSpelling.get(k);
    if (fromRows) return mostCounted(fromRows)!;
    return typed.trim();
  };

  const groupOf = (k: string, g: VocabGenre | undefined): string | undefined => {
    if (g?.parent) return g.parent;
    for (const key of [k, ...(g?.aliases.map((a) => a.key) ?? [])]) {
      const p = mapParent.get(key);
      if (p) return mostCounted(p);
    }
    const p = rowParent.get(k);
    return p ? mostCounted(p) : undefined;
  };

  const resolve = (style: string): ResolvedGenre => {
    const k = genreKey(style);
    const key = target(k);
    const g = byKey.get(key);
    const name = g ? g.name : shownSpelling(key, style);
    const parent = groupOf(key, g);
    const out: ResolvedGenre = parent === undefined ? { key, name } : { key, name, parent };
    // Family and macro come only from the vocabulary's primaryParent links, never from the
    // stored row parent or the genre map.
    if (g && levelOf(g) === 'genre') {
      const family = parentIn(g, 'family');
      if (family) {
        out.family = { key: family.key, name: family.name };
        const macro = parentIn(family, 'macro');
        if (macro) out.macro = { key: macro.key, name: macro.name };
      }
      if (g.tier) out.tier = g.tier;
    }
    return out;
  };

  const parentIn = (node: VocabGenre, level: GenreLevel): VocabGenre | undefined => {
    if (!node.primaryParent) return undefined;
    const p = byKey.get(node.primaryParent);
    return p && levelOf(p) === level ? p : undefined;
  };

  const hasTaxonomy = v.genres.some((g) => levelOf(g) === 'macro');
  return { resolve, groups, hasTaxonomy };
}

export function resolveGenre(
  style: string,
  vocab: GenreVocabulary | undefined,
  map: GenreMapEntry[],
  rows: ArtistGenres[] = [],
): ResolvedGenre {
  return genreResolver(vocab, map, rows).resolve(style);
}

// Inside one act: styles that resolve to the same genre become one, weights added.
// A style with no letter or digit is dropped.
// Read side: when the vocabulary has a taxonomy, each share also carries its macro and
// family names (NOT_GROUPED when the genre has none). Rank survives; two merged styles
// keep the smaller rank.
export function resolveShares(shares: GenreShare[], resolver: GenreResolver): GenreShare[] {
  const out: GenreShare[] = [];
  const at = new Map<string, number>();
  for (const s of shares) {
    const r = resolver.resolve(s.style);
    if (!r.key) continue;
    const i = at.get(r.key);
    if (i !== undefined) {
      const prev = out[i];
      const merged: GenreShare = { ...prev, weight: prev.weight + s.weight };
      const rank = prev.rank === undefined ? s.rank : s.rank === undefined ? prev.rank : Math.min(prev.rank, s.rank);
      if (rank !== undefined) merged.rank = rank;
      out[i] = merged;
      continue;
    }
    at.set(r.key, out.length);
    const share: GenreShare = { parent: r.parent ?? NOT_GROUPED, style: r.name, weight: s.weight };
    if (s.rank !== undefined) share.rank = s.rank;
    if (resolver.hasTaxonomy) {
      share.macro = r.macro?.name ?? NOT_GROUPED;
      share.family = r.family?.name ?? NOT_GROUPED;
    }
    out.push(share);
  }
  return out;
}

// The group a share shows: its scene family when the vocabulary has a taxonomy (macros are
// too broad to tell scenes apart), else its music-story parent (or "Not grouped").
export function shareGroup(x: GenreShare): string {
  return x.family ?? x.macro ?? (x.parent || NOT_GROUPED);
}

// The family a share shows, when it was read through a taxonomy.
export function shareFamily(x: GenreShare): string | undefined {
  return x.family;
}

// Every umbrella above each genre, at any depth, itself excluded. A loop already in
// the links cannot hang it: each genre is visited once.
export function umbrellaClosure(vocab: GenreVocabulary | undefined): Map<string, Set<string>> {
  const up = new Map<string, string[]>();
  for (const g of (vocab ?? EMPTY_VOCAB).genres) up.set(g.key, g.umbrellas);
  const out = new Map<string, Set<string>>();
  for (const start of up.keys()) {
    const seen = new Set<string>();
    const stack = [...(up.get(start) ?? [])];
    while (stack.length) {
      const k = stack.pop()!;
      if (k === start || seen.has(k)) continue;
      seen.add(k);
      stack.push(...(up.get(k) ?? []));
    }
    out.set(start, seen);
  }
  return out;
}

// The umbrellas a genre falls under, at any depth.
export function umbrellasOf(key: string, vocab: GenreVocabulary | undefined): Set<string> {
  return umbrellaClosure(vocab).get(key) ?? new Set();
}

// Every genre under an umbrella, at any depth, the umbrella itself excluded.
export function genresUnder(umbrellaKey: string, vocab: GenreVocabulary | undefined): Set<string> {
  const out = new Set<string>();
  for (const [k, ups] of umbrellaClosure(vocab)) if (k !== umbrellaKey && ups.has(umbrellaKey)) out.add(k);
  return out;
}

// True when putting genreKey under umbrellaKey would put a genre under itself.
export function wouldMakeUmbrellaLoop(
  genreKeyValue: string,
  umbrellaKey: string,
  vocab: GenreVocabulary | undefined,
): boolean {
  if (genreKeyValue === umbrellaKey) return true;
  return umbrellasOf(umbrellaKey, vocab).has(genreKeyValue);
}

// Every key with two or more spellings on shared rows or in the genre map and no
// chosen spelling (no vocabulary genre or alias with that key). Different keys that
// look alike are never listed.
export function genreCollisions(
  rows: ArtistGenres[],
  vocab: GenreVocabulary | undefined,
  map: GenreMapEntry[],
): GenreCollision[] {
  const v = vocab ?? EMPTY_VOCAB;
  const chosen = new Set<string>();
  for (const g of v.genres) {
    chosen.add(g.key);
    for (const a of g.aliases) chosen.add(a.key);
  }
  const spellings = new Map<string, Map<string, number>>();
  for (const m of map) {
    const name = m.style.trim();
    const k = genreKey(name);
    if (k) bump(spellings, k, name, 0);
  }
  for (const r of sharedRows(rows)) {
    const seen = new Set<string>();
    for (const s of r.genres) {
      const name = s.style.trim();
      const k = genreKey(name);
      if (!k || seen.has(name)) continue;
      seen.add(name);
      bump(spellings, k, name);
    }
  }
  const resolver = genreResolver(v, map, rows);
  const out: GenreCollision[] = [];
  for (const [key, names] of spellings) {
    if (names.size < 2 || chosen.has(key)) continue;
    const list = [...names]
      .map(([name, artists]) => ({ name, artists }))
      .sort((a, b) => b.artists - a.artists || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    out.push({ key, spellings: list, shown: resolver.resolve(key).name });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Human-readable rule breaks in the taxonomy (genre-taxonomy-phase-a.md section 2). The
// same rules are checked again in genre_vocabulary_write. Empty: valid.
export function checkTaxonomy(vocab: GenreVocabulary): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, VocabGenre>();
  for (const g of vocab.genres) byKey.set(g.key, g);

  const keySpaceOk = (level: GenreLevel, key: string): boolean =>
    level === 'genre'
      ? !key.includes(':')
      : level === 'family'
        ? key.startsWith('family:')
        : key.startsWith('macro:');

  for (const g of vocab.genres) {
    const level = levelOf(g);
    const label = `${g.name} (${g.key})`;
    if (!LEVELS.includes(level)) errors.push(`${label}: unknown level "${String(g.level)}"`);
    if (!keySpaceOk(level, g.key)) errors.push(`${label}: a ${level} key is in the wrong key space`);

    if (g.tier !== undefined) {
      if (level !== 'genre') errors.push(`${label}: only a genre has a tier`);
      if (!TIERS.includes(g.tier)) errors.push(`${label}: unknown tier "${g.tier}"`);
    }

    if (level === 'macro' && g.primaryParent !== undefined) {
      errors.push(`${label}: a macro has no primary parent`);
    }
    if (level === 'family') {
      const p = g.primaryParent === undefined ? undefined : byKey.get(g.primaryParent);
      if (!p) errors.push(`${label}: a family needs a primary parent that is a macro`);
      else if (levelOf(p) !== 'macro') errors.push(`${label}: a family's primary parent must be a macro`);
    }
    if (level === 'genre' && g.primaryParent !== undefined) {
      const p = byKey.get(g.primaryParent);
      if (!p) errors.push(`${label}: primary parent ${g.primaryParent} does not exist`);
      else if (levelOf(p) !== 'family') errors.push(`${label}: a genre's primary parent must be a family`);
    }
    if (g.primaryParent !== undefined && g.primaryParent === g.key) {
      errors.push(`${label}: cannot be its own primary parent`);
    }

    for (const r of g.relations ?? []) checkRelation(g, r, byKey, errors);
  }

  checkDerivedLoops(vocab, errors);
  return errors;
}

function checkRelation(
  g: VocabGenre,
  r: GenreRelation,
  byKey: Map<string, VocabGenre>,
  errors: string[],
): void {
  const label = `${g.name} (${g.key}) to ${r.target}`;
  const source = levelOf(g);
  const target = byKey.get(r.target);
  if (!RELATION_TYPES.includes(r.type)) errors.push(`${label}: unknown type "${r.type}"`);
  if (!RELATION_ORIGINS.includes(r.origin)) errors.push(`${label}: unknown origin "${r.origin}"`);
  if (!Number.isFinite(r.weight) || r.weight <= 0 || r.weight > 1) {
    errors.push(`${label}: weight ${r.weight} is outside (0, 1]`);
  }
  if (r.target === g.key) errors.push(`${label}: a relation cannot point at itself`);
  if (!target) {
    errors.push(`${label}: target ${r.target} does not exist`);
    return;
  }
  if (source !== 'genre') errors.push(`${label}: a relation starts at a genre`);
  if (r.type === 'secondary_parent' && levelOf(target) !== 'family') {
    errors.push(`${label}: a secondary_parent points at a family`);
  }
  if ((r.type === 'adjacent' || r.type === 'derived_from') && levelOf(target) !== 'genre') {
    errors.push(`${label}: ${r.type} points at a genre`);
  }
  if (r.type === 'adjacent' && g.key < r.target) {
    // Reported once per pair, from the smaller key.
    const reverse = byKey.get(r.target)?.relations?.some((x) => x.type === 'adjacent' && x.target === g.key);
    if (reverse) errors.push(`${g.name} (${g.key}) and ${r.target} are adjacent in both directions`);
  }
}

function checkDerivedLoops(vocab: GenreVocabulary, errors: string[]): void {
  const next = new Map<string, string[]>();
  for (const g of vocab.genres) {
    for (const r of g.relations ?? []) {
      if (r.type !== 'derived_from') continue;
      next.set(g.key, [...(next.get(g.key) ?? []), r.target]);
    }
  }
  for (const [source, targets] of next) {
    for (const target of targets) {
      const seen = new Set<string>();
      const stack = [target];
      let loops = false;
      while (stack.length && !loops) {
        const k = stack.pop()!;
        if (k === source) {
          loops = true;
          break;
        }
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(...(next.get(k) ?? []));
      }
      if (loops) errors.push(`${source} derived from ${target} makes a loop`);
    }
  }
}
