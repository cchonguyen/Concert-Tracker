// Pure CSV parser and shared types for Phase 1 Artist Entity Cleanup.
// Shared by the browser UI and server routes (no Node-only imports).
// Spec: docs/archive/artist-entity-cleanup.md.

import { normalizeName } from '../lineup/normalizeName';

export const ARTIST_CLEANUP_ORDER = [
  'invalid_non_artist',
  'merge_duplicate',
  'remap_set',
  'split_multi_artist',
  'rename',
  'link_alter_ego',
] as const;

export type ArtistCleanupStatus = (typeof ARTIST_CLEANUP_ORDER)[number];

export const MAX_CLEANUP_ROWS = 5000;

export interface ArtistCleanupSplitItem {
  name: string;
  key: string;
  normalizedKey: string;
}

export interface ArtistCleanupRow {
  line: number;
  artist: string;
  artistKey: string;
  mbid: string;
  source: string;
  version: string;
  status: ArtistCleanupStatus;
  invalidReason: string;
  canonicalArtist: string;
  canonicalKey: string;
  canonicalTargetKey: string;
  canonicalNewKey: string;
  setQualifier: string;
  splitItems: ArtistCleanupSplitItem[];
  comboAlias: string;
  alterEgoOf: string;
  alterEgoOfKey: string;
  alterEgoTargetKey: string;
  cleanupNotes: string;
}

export interface ArtistCleanupFailedResolution {
  line: number;
  artist: string;
  status: ArtistCleanupStatus;
  targetKey: string;
  reason: string;
}

export interface ArtistCleanupReport {
  dryRun: boolean;
  counts: Record<ArtistCleanupStatus, number>;
  totalRows: number;
  performancesMigrated: number;
  performancesDeduped: number;
  newArtistsInserted: number;
  parentStubsInserted: number;
  ownerEventsUpdated: number;
  failedResolutions: ArtistCleanupFailedResolution[];
  assertions: {
    remainingDeprecatedActive: number;
    orphanedPerformances: number;
    missingBlocklistEntries: number;
  };
}

const VALID_STATUSES = new Set<string>(ARTIST_CLEANUP_ORDER);

export function emptyStatusCounts(): Record<ArtistCleanupStatus, number> {
  return {
    invalid_non_artist: 0,
    merge_duplicate: 0,
    remap_set: 0,
    split_multi_artist: 0,
    rename: 0,
    link_alter_ego: 0,
  };
}

function targetNormalizedKey(key: string, fallbackName: string): string {
  if (key.startsWith('artist:')) return normalizeName(key.slice('artist:'.length));
  if (key === 'NEW') return normalizeName(fallbackName);
  return '';
}

function splitSemicolon(value: string): string[] {
  if (!value) return [];
  return value.split('; ').map((s) => s.replace(/^ +| +$/g, ''));
}

export function parseArtistCleanupCsv(table: string[][]): { rows: ArtistCleanupRow[]; errors: string[] } {
  if (table.length < 2) {
    return { rows: [], errors: ['The CSV file is empty or missing data rows.'] };
  }
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());

  const idxArtist = col('Artist');
  const idxStatus = col('Entity_Status');
  if (idxArtist < 0 || idxStatus < 0) {
    const missing = [idxArtist < 0 && 'Artist', idxStatus < 0 && 'Entity_Status'].filter(Boolean).join(', ');
    return { rows: [], errors: [`Missing required column(s): ${missing}.`] };
  }

  const idxMbid = col('MusicBrainz ID');
  const idxSource = col('Source');
  const idxVersion = col('Version (leave as it is)');
  const idxInvalidReason = col('Invalid_Reason');
  const idxCanonicalArtist = col('Canonical_Artist');
  const idxCanonicalKey = col('Canonical_Key');
  const idxSetQualifier = col('Set_Qualifier');
  const idxSplitArtists = col('Split_Artists');
  const idxSplitKeys = col('Split_Keys');
  const idxComboAlias = col('Combo_Alias');
  const idxAlterEgoOf = col('Alter_Ego_Of');
  const idxAlterEgoOfKey = col('Alter_Ego_Of_Key');
  const idxCleanupNotes = col('Cleanup_Notes');

  const cell = (row: string[], idx: number): string => (idx >= 0 && idx < row.length ? row[idx] ?? '' : '');

  const rows: ArtistCleanupRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < table.length; i++) {
    const raw = table[i];
    if (raw.every((c) => !c.trim())) continue;
    const line = i + 1;
    // Preserve exact characters (including \xa0 non-breaking spaces) in artist and key strings.
    const artist = cell(raw, idxArtist).replace(/[\r\n]+$/g, '');
    const statusRaw = cell(raw, idxStatus).trim();

    if (!artist) {
      errors.push(`Line ${line}: Artist is empty.`);
      continue;
    }
    if (!VALID_STATUSES.has(statusRaw)) {
      errors.push(`Line ${line} ("${artist}"): Unknown Entity_Status "${statusRaw}".`);
      continue;
    }
    const status = statusRaw as ArtistCleanupStatus;
    const mbid = cell(raw, idxMbid).trim();
    const source = cell(raw, idxSource).trim();
    const version = cell(raw, idxVersion).trim();
    const invalidReason = cell(raw, idxInvalidReason).trim();
    const canonicalArtist = cell(raw, idxCanonicalArtist).replace(/[\r\n]+$/g, '');
    const canonicalKey = cell(raw, idxCanonicalKey).replace(/[\r\n]+$/g, '');
    const setQualifier = cell(raw, idxSetQualifier).trim();
    const splitArtistsRaw = cell(raw, idxSplitArtists).replace(/[\r\n]+$/g, '');
    const splitKeysRaw = cell(raw, idxSplitKeys).replace(/[\r\n]+$/g, '');
    const comboAlias = cell(raw, idxComboAlias).trim();
    const alterEgoOf = cell(raw, idxAlterEgoOf).replace(/[\r\n]+$/g, '');
    const alterEgoOfKey = cell(raw, idxAlterEgoOfKey).replace(/[\r\n]+$/g, '');
    const cleanupNotes = cell(raw, idxCleanupNotes).trim();

    const splitItems: ArtistCleanupSplitItem[] = [];
    if (status === 'split_multi_artist') {
      const names = splitSemicolon(splitArtistsRaw);
      const keys = splitSemicolon(splitKeysRaw);
      if (names.length < 2 || names.length !== keys.length) {
        errors.push(`Line ${line} ("${artist}"): Split_Artists (${names.length}) and Split_Keys (${keys.length}) must match with at least 2 artists.`);
        continue;
      }
      for (let j = 0; j < names.length; j++) {
        splitItems.push({
          name: names[j],
          key: keys[j],
          normalizedKey: keys[j] === 'NEW' ? normalizeName(names[j]) : targetNormalizedKey(keys[j], names[j]),
        });
      }
    }

    if ((status === 'merge_duplicate' || status === 'remap_set') && !canonicalKey) {
      errors.push(`Line ${line} ("${artist}"): ${status} requires Canonical_Key.`);
      continue;
    }
    if (status === 'rename' && !canonicalArtist) {
      errors.push(`Line ${line} ("${artist}"): rename requires Canonical_Artist.`);
      continue;
    }
    if (status === 'link_alter_ego' && (!alterEgoOf || !alterEgoOfKey)) {
      errors.push(`Line ${line} ("${artist}"): link_alter_ego requires Alter_Ego_Of and Alter_Ego_Of_Key.`);
      continue;
    }

    rows.push({
      line,
      artist,
      artistKey: normalizeName(artist),
      mbid,
      source,
      version,
      status,
      invalidReason,
      canonicalArtist,
      canonicalKey,
      canonicalTargetKey: targetNormalizedKey(canonicalKey, canonicalArtist),
      canonicalNewKey: canonicalArtist ? normalizeName(canonicalArtist) : '',
      setQualifier,
      splitItems,
      comboAlias,
      alterEgoOf,
      alterEgoOfKey,
      alterEgoTargetKey: targetNormalizedKey(alterEgoOfKey, alterEgoOf),
      cleanupNotes,
    });
  }

  // Enforce strict 6-stage execution order regardless of input CSV row order.
  rows.sort((a, b) => ARTIST_CLEANUP_ORDER.indexOf(a.status) - ARTIST_CLEANUP_ORDER.indexOf(b.status) || a.line - b.line);
  return { rows, errors };
}
