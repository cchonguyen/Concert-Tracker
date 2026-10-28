// The core check: a value counts only if its quote occurs in the source text,
// and the value occurs in the quote. Nothing is loosened here.

export function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isVerbatim(value: string, quote: string, source: string): boolean {
  const v = normalize(value);
  const q = normalize(quote);
  if (!v || !q) return false;
  return containsPhrase(normalize(source), q) && containsPhrase(q, v);
}

function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}
