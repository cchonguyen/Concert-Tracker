import { AdapterContext, AdapterResult, NewPerformerClaim, SourceAdapter } from '../types';
import { emptyResult, makeDocument } from './common';
import { parsePastedSets } from '../pasted';

// A set-times page the owner pasted with its link (docs/specs/pasted-set-times.md). The app never requests the link:
// the pasted text is stored as the source document and read in code by parsePastedSets. No model call.
const VERSION = 'pasted@1';

export const pastedAdapter: SourceAdapter = {
  id: 'pasted',
  enabled: () => true,

  async collect(ctx: AdapterContext): Promise<AdapterResult> {
    const result = emptyResult();
    const pasted = ctx.input.pasted;
    if (!pasted) return result;
    const doc = makeDocument(pasted.url, 'pasted', pasted.text, 'text');
    result.documents.push(doc);
    if (!ctx.input.startDate) {
      result.notes.push('Pasted page: the event has no full date, so no set time could be placed.');
    }
    const read = ctx.input.startDate
      ? parsePastedSets(pasted.text, { startDate: ctx.input.startDate, endDate: ctx.input.endDate })
      : parsePastedSets(pasted.text, { startDate: '0000-01-01' });
    result.performers = read.sets.map(
      (s): NewPerformerClaim => ({
        documentId: doc.id,
        sourceType: 'pasted',
        sourceUrl: pasted.url,
        name: s.name,
        quotedSpan: s.quote,
        evidence: 'crowd',
        ...(ctx.input.startDate && s.set
          ? { day: s.set.day, stage: s.set.stage, startTime: s.set.start, endTime: s.set.end }
          : {}),
        extractor: 'pasted',
        extractorVersion: VERSION,
      }),
    );
    const timed = result.performers.filter((p) => p.startTime).length;
    result.notes.push(
      `Pasted page: ${result.performers.length} act(s), ${timed} with a set time; ${read.unread.length} line(s) not read.`,
    );
    return result;
  },
};
