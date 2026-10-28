export type { RawEmailMessage, FieldEvidence, EmailImportProposal } from './types.ts';
export { htmlToLines, textToLines, decodeEntities } from './text.ts';
export { readEmailDate, yearFromWeekday } from './dates.ts';
export type { EmailDate } from './dates.ts';
export { isVerbatim, normalize } from './verbatim.ts';
export { STREAM_A_QUERY, STREAM_B_QUERY, queriesSince, LOOKBACK_DAYS } from './queries.ts';
export { readPkpass, unzipEntry } from './markup.ts';
export type { PassTicket, PassField } from './markup.ts';
