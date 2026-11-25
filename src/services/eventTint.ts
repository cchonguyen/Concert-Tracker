// Per-event tint (design refresh 2.0, spec section 2 "Per-event tint").
// A soft colour for an event's poster wash and the dot beside its series name.
// The hue is worked out in code from the series name, or the event's own name
// when it has no series, so every year of a series shares one colour. It is
// decoration only: it stands in for no data and never sits behind text.

export const TINT_KEY = 'livearchive.eventTint.v1';

// OKLCH hue angles, spread around the wheel so neighbours read as different.
export const TINT_HUES = [25, 60, 95, 140, 185, 225, 270, 320] as const;

// FNV-1a over the trimmed, lower-cased name: fast, stable across sessions and devices.
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const key = (name: string | null | undefined) => (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// The hue for an event, or null when it has neither a series name nor a name.
export function tintHue(seriesName: string | null | undefined, eventName?: string | null): number | null {
  const k = key(seriesName) || key(eventName);
  if (!k) return null;
  return TINT_HUES[hash(k) % TINT_HUES.length];
}

// The switch is on unless the person turned it off on this device.
export const parseTintOn = (v: string | null | undefined): boolean => v !== 'off';
