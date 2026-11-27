// Bill links maths: NPMI over stage or edition bills (docs/specs/genre-taxonomy-release-3.md, section 6).
// Pure functions only: no store access, no I/O. The caller supplies performances and
// resolved genres; this module returns the candidate links and the counts it used.

export interface CooccurPerformance {
  editionId: string;
  artistKey: string;
  stages: string[];
  status?: string;
  slotId?: string;
}

export interface CooccurOptions {
  /** Curated pairs as 'a|b', either order. These pairs are never returned. */
  curated?: Set<string>;
  /** Support floor: a pair must be on at least this many bills. Default 3. */
  minBills?: number;
  /** NPMI floor. Default 0.2. */
  minNpmi?: number;
  /** Each genre keeps at most this many links. Default 5. */
  perGenre?: number;
  /** Each act contributes its first N genres. Default 3. */
  topGenres?: number;
}

export interface CooccurLink {
  source: string;
  target: string;
  weight: number;
  /** n_gh: bills that contain both genres. */
  bills: number;
}

export interface CooccurResult {
  links: CooccurLink[];
  /** N: bills with at least one genre. */
  billsUsed: number;
  /** Genres seen on at least one counted bill, with n_g. Sorted by genre key. */
  genres: { genre: string; bills: number }[];
}

/**
 * Builds bills from performances.
 * - Cancelled performances are skipped.
 * - An edition with stages gives one bill per stage. An act is in a stage bill when it has
 *   that stage. An act with no stage at all at that edition joins a no-stage bill only when
 *   2 or more such acts exist; a lone no-stage act is dropped.
 * - An edition with no stages gives one bill of all its acts.
 * - Acts are deduped and sorted within a bill; bills are ordered by edition, then stage.
 */
export function billsFrom(perfs: CooccurPerformance[]): string[][] {
  const byEdition = new Map<string, CooccurPerformance[]>();
  for (const p of perfs) {
    if (p.status === 'cancelled') continue;
    const list = byEdition.get(p.editionId) ?? [];
    list.push(p);
    byEdition.set(p.editionId, list);
  }

  const bills: string[][] = [];
  for (const editionId of [...byEdition.keys()].sort()) {
    const rows = byEdition.get(editionId) ?? [];
    const byStage = new Map<string, Set<string>>();
    const staged = new Set<string>();
    const everyAct = new Set<string>();
    for (const row of rows) {
      everyAct.add(row.artistKey);
      const stages = [...new Set(row.stages.map((s) => s.trim()).filter((s) => s !== ''))];
      for (const stage of stages) {
        staged.add(row.artistKey);
        const set = byStage.get(stage) ?? new Set<string>();
        set.add(row.artistKey);
        byStage.set(stage, set);
      }
    }

    if (byStage.size === 0) {
      if (everyAct.size > 0) bills.push([...everyAct].sort());
      continue;
    }
    for (const stage of [...byStage.keys()].sort()) {
      const set = byStage.get(stage);
      if (set && set.size > 0) bills.push([...set].sort());
    }
    const noStage = [...everyAct].filter((a) => !staged.has(a)).sort();
    if (noStage.length >= 2) bills.push(noStage);
  }
  return bills;
}

/**
 * NPMI for genres g and h over N bills. n_gh = N gives exactly 1.
 * PMI = ln(n_gh·N / (n_g·n_h)); NPMI = PMI / −ln(n_gh / N).
 */
export function npmi(nGh: number, nG: number, nH: number, N: number): number {
  if (nGh >= N) return 1;
  const pmi = Math.log((nGh * N) / (nG * nH));
  return pmi / -Math.log(nGh / N);
}

// Plain code-unit order, so results do not depend on the machine's locale.
function codeCompare(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function uniqueInOrder(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Learns genre links from bills.
 * - Each act contributes its first `topGenres` genres. A bill's genre set is the union over
 *   its acts, so a genre repeated on one bill counts once.
 * - N counts bills with at least one genre. Bills with no genre at all are left out of N,
 *   since they cannot say anything about a pair.
 * - Keeps pairs with n_gh >= minBills and NPMI >= minNpmi, skipping curated pairs.
 * - Cap: a pair survives only if it is among the first `perGenre` candidates of BOTH its
 *   genres, where candidates are ranked by weight desc, then source, then target. So no genre
 *   ever keeps more than `perGenre` links.
 * - Weight is NPMI rounded to 3 decimals. A pair whose rounded weight is not in (0, 1] is dropped.
 */
export function lineupCooccur(
  bills: string[][],
  genresOf: (artistKey: string) => string[],
  opts: CooccurOptions = {},
): CooccurResult {
  const minBills = opts.minBills ?? 3;
  const minNpmi = opts.minNpmi ?? 0.2;
  const perGenre = opts.perGenre ?? 5;
  const topGenres = opts.topGenres ?? 3;
  const curated = opts.curated ?? new Set<string>();

  const actGenres = new Map<string, string[]>();
  const genresForAct = (artistKey: string): string[] => {
    const cached = actGenres.get(artistKey);
    if (cached) return cached;
    const list = uniqueInOrder(
      (genresOf(artistKey) ?? []).filter((g) => typeof g === 'string' && g !== '').slice(0, topGenres),
    );
    actGenres.set(artistKey, list);
    return list;
  };

  const billGenreSets: string[][] = [];
  for (const bill of bills) {
    const set = new Set<string>();
    for (const act of uniqueInOrder(bill)) for (const g of genresForAct(act)) set.add(g);
    if (set.size > 0) billGenreSets.push([...set].sort());
  }
  const N = billGenreSets.length;

  const nG = new Map<string, number>();
  const nPair = new Map<string, { a: string; b: string; n: number }>();
  for (const genres of billGenreSets) {
    for (const g of genres) nG.set(g, (nG.get(g) ?? 0) + 1);
    for (let i = 0; i < genres.length; i++) {
      for (let j = i + 1; j < genres.length; j++) {
        const a = genres[i] ?? '';
        const b = genres[j] ?? '';
        const key = `${a}\u0000${b}`;
        const entry = nPair.get(key) ?? { a, b, n: 0 };
        entry.n += 1;
        nPair.set(key, entry);
      }
    }
  }

  const candidates: CooccurLink[] = [];
  for (const { a, b, n } of nPair.values()) {
    if (n < minBills) continue;
    if (curated.has(`${a}|${b}`) || curated.has(`${b}|${a}`)) continue;
    const score = npmi(n, nG.get(a) ?? 0, nG.get(b) ?? 0, N);
    if (!(score >= minNpmi)) continue;
    const weight = Math.min(1, Math.round(score * 1000) / 1000);
    if (!(weight > 0)) continue;
    candidates.push({ source: a, target: b, weight, bills: n });
  }
  candidates.sort(
    (x, y) => y.weight - x.weight || codeCompare(x.source, y.source) || codeCompare(x.target, y.target),
  );

  const rankCount = new Map<string, number>();
  const nextRank = (genre: string): number => {
    const rank = rankCount.get(genre) ?? 0;
    rankCount.set(genre, rank + 1);
    return rank;
  };
  const links: CooccurLink[] = [];
  for (const c of candidates) {
    const rs = nextRank(c.source);
    const rt = nextRank(c.target);
    if (rs < perGenre && rt < perGenre) links.push(c);
  }

  const genres = [...nG.keys()]
    .sort()
    .map((genre) => ({ genre, bills: nG.get(genre) ?? 0 }));

  return { links, billsUsed: N, genres };
}
