import { randomUUID } from 'node:crypto';
import { AdapterResult, FactClaim, SourceDocument, SourceType } from '../types';
import { sha256 } from '../text';

export function makeDocument(
  url: string,
  sourceType: SourceType,
  body: string,
  contentType: SourceDocument['contentType'],
): SourceDocument {
  return {
    id: randomUUID(),
    url,
    sourceType,
    fetchedAt: new Date().toISOString(),
    contentHash: sha256(body),
    contentType,
    body,
  };
}

export function emptyResult(): AdapterResult {
  return { documents: [], performers: [], facts: {}, extractionQueue: [], notes: [] };
}

export function fact(value: string | undefined, sourceType: SourceType, sourceUrl: string): FactClaim[] {
  return value ? [{ value, sourceType, sourceUrl }] : [];
}
