// Brand rename, merge and organization change as plans (Global Editions slice 2).
// Pure functions: they take the current rows and return what would change, plus the
// manifest needed to undo it. The store applies a plan and writes brand_history; nothing
// here touches the database. Shared data only: no personal fields.

export interface BrandRow {
  id: string;
  name: string;
  aliases: string[];
  organizationId: string | null;
}

export interface SeriesLink {
  slug: string;
  brandId: string | null;
}

export class BrandError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export const MAX_BRAND_NAME = 80;

export const brandKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

// Trims, collapses inner spaces and rejects blanks or over-long names.
export function normalizeBrandName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BrandError('Enter a brand name.');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw new BrandError('Enter a brand name.');
  if (name.length > MAX_BRAND_NAME) throw new BrandError(`Keep the brand name under ${MAX_BRAND_NAME} characters.`);
  return name;
}

// Aliases: trimmed, case-insensitively unique, and never equal to the brand's own name.
export function cleanAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set<string>([brandKey(name)]);
  const out: string[] = [];
  for (const a of aliases) {
    const t = a.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const k = brandKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export interface BrandChangeRecord {
  operation: 'rename' | 'merge' | 'organization';
  brandId: string;
  mergedFromId?: string;
  before: { name: string; aliases: string[]; organizationId: string | null };
  after: { name: string; aliases: string[]; organizationId: string | null };
  // Series whose brand_id moved, with the brand they came from and went to.
  seriesMoved: Array<{ slug: string; fromBrandId: string; toBrandId: string }>;
  // Brand rows removed by a merge; restored on undo.
  removedBrand?: BrandRow;
  at: string;
}

const snapshot = (b: BrandRow) => ({ name: b.name, aliases: [...b.aliases], organizationId: b.organizationId });

// Rename: the old name stays searchable as an alias. A name already used by another brand is refused.
export function planRename(brand: BrandRow, newName: unknown, others: readonly BrandRow[], at: string): BrandChangeRecord {
  const name = normalizeBrandName(newName);
  const clash = others.find((o) => o.id !== brand.id && brandKey(o.name) === brandKey(name));
  if (clash) throw new BrandError(`Another brand is already called "${clash.name}". Merge the two instead.`, 409);
  const aliases = cleanAliases(name, [...brand.aliases, ...(brandKey(brand.name) === brandKey(name) ? [] : [brand.name])]);
  return {
    operation: 'rename',
    brandId: brand.id,
    before: snapshot(brand),
    after: { name, aliases, organizationId: brand.organizationId },
    seriesMoved: [],
    at,
  };
}

// Organization: attach to one organization, or detach with null.
export function planOrganization(brand: BrandRow, organizationId: string | null, at: string): BrandChangeRecord {
  return {
    operation: 'organization',
    brandId: brand.id,
    before: snapshot(brand),
    after: { name: brand.name, aliases: [...brand.aliases], organizationId },
    seriesMoved: [],
    at,
  };
}

// Merge: the source's series move to the target, the source's name and aliases become
// aliases of the target, and the source row is removed. The target keeps its own
// organization; it takes the source's only when it has none.
export function planMerge(
  source: BrandRow,
  target: BrandRow,
  series: readonly SeriesLink[],
  at: string,
): BrandChangeRecord {
  if (source.id === target.id) throw new BrandError('Pick two different brands to merge.');
  const aliases = cleanAliases(target.name, [...target.aliases, source.name, ...source.aliases]);
  const organizationId = target.organizationId ?? source.organizationId;
  return {
    operation: 'merge',
    brandId: target.id,
    mergedFromId: source.id,
    before: snapshot(target),
    after: { name: target.name, aliases, organizationId },
    seriesMoved: series
      .filter((s) => s.brandId === source.id)
      .map((s) => ({ slug: s.slug, fromBrandId: source.id, toBrandId: target.id })),
    removedBrand: { ...source, aliases: [...source.aliases] },
    at,
  };
}

export interface UndoPlan {
  // The brand the change edited, put back to its state before the change.
  restoreTarget: { id: string; name: string; aliases: string[]; organizationId: string | null };
  // The brand a merge removed, re-created from its row.
  restoreBrand: { id: string; name: string; aliases: string[]; organizationId: string | null } | null;
  // Series to put back on the merged-away brand. Only series still on the target are moved back.
  relinkSeries: Array<{ slug: string; brandId: string }>;
  // Series that changed since the change; left as they are.
  skippedSeries: string[];
}

// Undo: puts back what one change did. A brand whose row no longer matches the change's
// result is refused (someone changed it since), as the Manage undo refuses changed records.
export function planUndo(
  change: BrandChangeRecord,
  currentTarget: BrandRow | null,
  series: readonly SeriesLink[],
  alreadyUndone: boolean,
): UndoPlan {
  if (alreadyUndone) throw new BrandError('That change was already undone.', 409);
  if (!currentTarget) throw new BrandError('The brand this change touched no longer exists.', 409);
  const sameAsAfter =
    currentTarget.name === change.after.name &&
    currentTarget.organizationId === change.after.organizationId &&
    JSON.stringify(currentTarget.aliases) === JSON.stringify(change.after.aliases);
  if (!sameAsAfter) throw new BrandError('This brand changed after this change. Undo the later change first.', 409);

  const current = new Map(series.map((s) => [s.slug, s.brandId]));
  const relinkSeries: UndoPlan['relinkSeries'] = [];
  const skippedSeries: string[] = [];
  for (const m of change.seriesMoved) {
    if (current.get(m.slug) === m.toBrandId) relinkSeries.push({ slug: m.slug, brandId: m.fromBrandId });
    else skippedSeries.push(m.slug);
  }
  const restoreTarget = { id: change.brandId, ...snapshot({ id: change.brandId, ...change.before }) };
  const restoreBrand = change.removedBrand
    ? { id: change.removedBrand.id, name: change.removedBrand.name, aliases: [...change.removedBrand.aliases], organizationId: change.removedBrand.organizationId }
    : null;
  return { restoreTarget, restoreBrand, relinkSeries, skippedSeries };
}
