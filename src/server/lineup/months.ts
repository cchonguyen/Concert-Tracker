// The app's one month table and calendar-date check. No imports, so the
// browser and the server both use it. Each date reader keeps its own patterns and rules (email keeps its own year
// rule); only the month words, the month pattern and the date check live here.

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
const MONTH_KEYS = MONTH_SHORT.map((m) => m.toLowerCase());

// A month word in text, captured: "Jan", "January", "Sept", "Sept.", "june". For use inside a RegExp.
export const MONTH_PATTERN = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

// 1 to 12 from a month word, by its first three letters; 0 when it is not a month.
export function monthIndex(word: string): number {
  return MONTH_KEYS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
}

// yyyy-mm-dd for a real calendar day; undefined for a day that does not exist (Feb 30, month 13).
export function isoDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return undefined;
  return d.toISOString().slice(0, 10);
}
