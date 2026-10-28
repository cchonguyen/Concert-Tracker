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
