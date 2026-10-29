// The save status beside an event detail. Pure: the screen feeds it each save's start, success or failure,
// and reads back the label. A failed patch is kept until a retry of it works, so "Try again" can resend it.

export interface SaveTrack<P> {
  inFlight: number;
  failed: P[];
  savedAt: number | null;
}

export function emptyTrack<P>(): SaveTrack<P> {
  return { inFlight: 0, failed: [], savedAt: null };
}

export function beginSave<P>(t: SaveTrack<P>): SaveTrack<P> {
  return { ...t, inFlight: t.inFlight + 1 };
}

export function succeedSave<P>(t: SaveTrack<P>, at: number): SaveTrack<P> {
  return { ...t, inFlight: Math.max(0, t.inFlight - 1), savedAt: at };
}

export function failSave<P>(t: SaveTrack<P>, patch: P): SaveTrack<P> {
  return { ...t, inFlight: Math.max(0, t.inFlight - 1), failed: [...t.failed, patch] };
}

// Takes the failed patches out for a retry; each one then begins its own save.
export function takeFailed<P>(t: SaveTrack<P>): { track: SaveTrack<P>; patches: P[] } {
  return { track: { ...t, failed: [] }, patches: t.failed };
}

// The line shown on screen. Saving wins over a failure, a failure over a finished save.
export function saveLabel<P>(t: SaveTrack<P>, now: number): string {
  if (t.inFlight > 0) return 'Saving…';
  if (t.failed.length > 0) return "Couldn't save · Try again";
  if (t.savedAt === null) return '';
  return `Saved · ${agoLabel(now - t.savedAt)}`;
}

export function agoLabel(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

// The "Changes save as you go" hint shows for the first few times an event is opened on a device.
export const HINT_VISITS = 3;

// Given the stored count (or null), whether to show the hint now and the count to store.
export function hintVisit(raw: string | null): { show: boolean; next: number } {
  const count = Number.parseInt(raw ?? '0', 10);
  const seen = Number.isFinite(count) && count >= 0 ? count : 0;
  return { show: seen < HINT_VISITS, next: seen + 1 };
}
