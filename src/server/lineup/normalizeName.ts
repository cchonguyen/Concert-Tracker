// Pure name normalization shared by the server and the client. No Node imports.
// Lowercase, strip diacritics and punctuation, collapse whitespace.
// Used for merge keys and the verbatim check; never for display.
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
