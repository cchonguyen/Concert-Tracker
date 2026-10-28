// Records for the things that repeat across events (migration 0014). Each
// has a permanent ID; events point at them. Contracts: .spec/SYSTEM_SPEC.md
// section 3.

export type EntityKind = 'artist' | 'person' | 'venue' | 'place' | 'series' | 'organization';

export const ENTITY_KINDS: EntityKind[] = ['artist', 'person', 'venue', 'place', 'series', 'organization'];

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  nameNormalized: string;
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

export type LinkRole = 'in' | 'hosted_by';

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
];

// One rename, merge, alias or link change, with everything needed to undo
// it exactly (entity_history). Lists hold the full before and after state of
// what the change touched; events hold only the fields it changed.
export interface HistoryEntry {
  id: string;
  operation: 'rename' | 'merge' | 'alias-add' | 'alias-remove' | 'link-add' | 'link-remove' | 'create';
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
}
