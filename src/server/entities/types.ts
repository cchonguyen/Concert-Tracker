// Records for the things that repeat across events (migration 0014). Each
// has a permanent ID; events point at them. Contracts: .spec/SYSTEM_SPEC.md
// section 3.

import type { ArtistIdentity, EditionPerformance, SeriesRecord } from '../lineup/types';

// One performance row: the edition it is in, with the act's fields.
export type ArtistEditionRow = EditionPerformance & { editionId: string };

export type EntityKind = 'artist' | 'person' | 'venue' | 'place' | 'series' | 'organization' | 'label';

export const ENTITY_KINDS: EntityKind[] = ['artist', 'person', 'venue', 'place', 'series', 'organization', 'label'];

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  nameNormalized: string;
  // A member's person whose vault is on: the name is encrypted in the browser
  // (name and nameNormalized stay empty, so the server never holds it) and
  // typed names find it through alias tokens (src/services/vault.ts, nameToken).
  nameEncrypted?: string;
  // Facts about the thing itself. A place keeps { city, region?, country? }.
  attrs: Record<string, unknown>;
  // Set when merged into another record; never chains (merges are flattened).
  mergedIntoId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntityAlias {
  entityId: string;
  kind: EntityKind;
  aliasNormalized: string;
}

export type LinkRole = 'in' | 'hosted_by' | 'has_label' | 'introduced_me_to';

export interface EntityLink {
  fromId: string;
  toId: string;
  role: LinkRole;
  createdAt: string;
}

// The relationships a link may express, checked on every write.
export const ALLOWED_LINKS: Array<{ from: EntityKind; role: LinkRole; to: EntityKind }> = [
  { from: 'venue', role: 'in', to: 'place' },
  { from: 'series', role: 'hosted_by', to: 'organization' },
  // Labels (migration 0016): picked from your list, one per group (Indoor or
  // Outdoor) on each record.
  { from: 'venue', role: 'has_label', to: 'label' },
  { from: 'series', role: 'has_label', to: 'label' },
  // Who got you into an artist (Manage step 6).
  { from: 'person', role: 'introduced_me_to', to: 'artist' },
];

// One rename, merge, alias or link change, with everything needed to undo
// it exactly (entity_history). Lists hold the full before and after state of
// what the change touched; events hold only the fields it changed.
// A catalog artist change (Global archive, canonical_artists). Its own
// before and after, so undo can put back exactly what it changed.
export interface ArtistAliasRow {
  alias: string; // normalized AKA (artist_aliases)
  name: string; // the canonical name it points to
}
export interface CanonicalChange {
  // The artist key the change started from.
  key: string;
  artists: { before: ArtistIdentity[]; after: ArtistIdentity[] };
  performances: { before: ArtistEditionRow[]; after: ArtistEditionRow[] };
  aliases: { before: ArtistAliasRow[]; after: ArtistAliasRow[] };
  // The owner's own record changed by the same step (an existing user_entities change). Undone first.
  personalHistoryId?: string;
}

export const CANONICAL_OPERATIONS = ['canonical-rename', 'canonical-merge', 'canonical-alias-add', 'canonical-alias-remove', 'canonical-series'] as const;

export interface HistoryEntry {
  id: string;
  operation: 'rename' | 'merge' | 'alias-add' | 'alias-remove' | 'link-add' | 'link-remove' | 'details' | 'create' | 'remove' | (typeof CANONICAL_OPERATIONS)[number];
  summary: string;
  sourceEntityId: string;
  targetEntityId?: string;
  entities: { before: Entity[]; after: Entity[] };
  // Aliases and links of these records, before and after.
  touched: string[];
  aliases: { before: EntityAlias[]; after: EntityAlias[] };
  links: { before: EntityLink[]; after: EntityLink[] };
  events: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
  createdAt: string;
  undoneAt?: string;
  // Made in the browser for a change the server cannot read (a person in the
  // vault): it has no stored entry to undo, and its events changed.
  eventsChanged?: boolean;
  // Set on a catalog artist change (CANONICAL_OPERATIONS); its records are not entities.
  canonical?: CanonicalChange;
  // Set on a series save (CANONICAL_OPERATIONS 'canonical-series'): the full record before and after, so undo puts it back.
  // A merge (mergeSeriesLogged) also carries the dropped record, so undo can put it back first.
  series?: { slug: string; before: SeriesRecord; after: SeriesRecord; dropped?: SeriesRecord };
}
