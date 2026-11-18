// Auto-verify rules for shared acts and editions (docs/auto-verify-spec.md, slice 2).
// Pure functions: no model call, no store, no writes. Callers pass the evidence they
// already fetched and stored, and apply the result through writeEdition (slice 3).

export type EvidenceKind =
  // A ticket email the person imported (a verified source for name, date, venue, city).
  | 'ticket_email'
  // A promoter or lineup page the app fetched and stored, quoting the act.
  | 'fetched_page'
  // An external API record that has the act's name and date (e.g. MusicBrainz).
  | 'api_record'
  // An external ID only (e.g. a setlist.fm ID). It cannot carry a name or date by itself.
  | 'external_id'
  // A member's own tick. Never counts as a source for verification.
  | 'member_entry';

export interface ActEvidence {
  // Distinct per source: a URL, an email ID or a record ID. Two items with one ID count once.
  sourceId: string;
  kind: EvidenceKind;
  // True for sources on the owner's trusted list (a ticket email, or a promoter the owner named).
  trusted: boolean;
  editionKey: string;
  name: string;
  date: string; // yyyy-mm-dd
}

export interface ActExpectation {
  editionKey: string;
  name: string;
  date: string;
}

export type ActStatus = 'verified' | 'candidate';
export type ActVerifiedBy = 'trusted_source' | 'two_sources' | 'none';

export interface ActVerdict {
  status: ActStatus;
  verifiedBy: ActVerifiedBy;
  // Distinct usable sources that agree with the act.
  sourceCount: number;
}

// Kinds that can carry a name and date on their own.
const USABLE: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['ticket_email', 'fetched_page', 'api_record']);

// Lower-case, accents removed, punctuation and spacing collapsed. Used only for comparing names.
export function normalizeActName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Decides whether an act is verified for one edition. A trusted usable source is enough.
// Otherwise two distinct usable sources that agree are needed. Member ticks, external IDs
// and disagreeing or duplicate sources never verify.
export function verifyAct(evidence: readonly ActEvidence[], expected: ActExpectation): ActVerdict {
  const want = normalizeActName(expected.name);
  const agreeing = evidence.filter(
    (e) =>
      USABLE.has(e.kind) &&
      e.editionKey === expected.editionKey &&
      e.date === expected.date &&
      normalizeActName(e.name) === want,
  );
  const sourceIds = new Set(agreeing.map((e) => e.sourceId));
  const sourceCount = sourceIds.size;
  if (agreeing.some((e) => e.trusted)) return { status: 'verified', verifiedBy: 'trusted_source', sourceCount };
  if (sourceCount >= 2) return { status: 'verified', verifiedBy: 'two_sources', sourceCount };
  return { status: 'candidate', verifiedBy: 'none', sourceCount };
}

// Once verified, an act stays verified. A later disagreeing source is a note for the owner,
// never a demotion.
export function nextActStatus(current: ActStatus, verdict: ActVerdict): ActStatus {
  return current === 'verified' ? 'verified' : verdict.status;
}

export const EDITION_FIELDS = ['name', 'act', 'location', 'venue', 'date'] as const;
export type EditionField = (typeof EDITION_FIELDS)[number];

// Each field's value and whether a verified source supplied it.
export type EditionFieldFacts = Partial<Record<EditionField, { value?: string; verified: boolean }>>;

// An edition is verified in code only when all five fields have a value from a verified source.
export function editionVerified(facts: EditionFieldFacts): boolean {
  return EDITION_FIELDS.every((field) => {
    const f = facts[field];
    return !!f && typeof f.value === 'string' && f.value.trim() !== '' && f.verified;
  });
}

// Fills only empty fields. A value the owner typed is never overwritten, and an incoming value
// never replaces another value. Returns the fields it filled, in order.
export function fillEmptyFields(
  current: Partial<Record<EditionField, string>>,
  incoming: Partial<Record<EditionField, string>>,
  ownerTyped: ReadonlySet<EditionField>,
): EditionField[] {
  const filled: EditionField[] = [];
  for (const field of EDITION_FIELDS) {
    const next = incoming[field]?.trim();
    const cur = current[field];
    if (!next || ownerTyped.has(field)) continue;
    if (cur !== undefined && cur.trim() !== '') continue;
    current[field] = next;
    filled.push(field);
  }
  return filled;
}
