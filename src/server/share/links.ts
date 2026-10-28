import { createHash, randomUUID } from 'node:crypto';
import type { LineupStore } from '../lineup/store/types';
import type { ShareLink, ShareSettings } from './types';

// Share link codes and settings. A code is 16 random bytes (128 bits) as 22
// URL-safe characters; only its SHA-256 hash is stored. One link is active at
// a time: making a new one turns the old one off.

export const SHARE_CODE = /^[A-Za-z0-9_-]{22}$/;

export function newShareCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export const hashShareCode = (code: string) => createHash('sha256').update(code).digest('hex');

export class ShareSettingsError extends Error {}

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// Checks settings sent from the Share panel. Dates and venues are shown
// unless switched off; format is shown only when switched on.
export function readShareSettings(input: unknown): ShareSettings {
  const v = (input ?? {}) as Record<string, unknown>;
  const displayName = typeof v.displayName === 'string' ? v.displayName.trim() : '';
  if (!displayName) throw new ShareSettingsError('Give the page a name to show.');
  if (displayName.length > 60) throw new ShareSettingsError('Keep the name to 60 characters or fewer.');
  const timeZone = typeof v.timeZone === 'string' ? v.timeZone : '';
  if (!isTimeZone(timeZone)) throw new ShareSettingsError('Unknown time zone.');
  const flag = (key: string, fallback: boolean) => (typeof v[key] === 'boolean' ? (v[key] as boolean) : fallback);
  return {
    displayName,
    timeZone,
    showDates: flag('showDates', true),
    showVenues: flag('showVenues', true),
    showFormat: flag('showFormat', false),
  };
}

export const activeLink = (links: ShareLink[]) => links.find((l) => !l.revokedAt);

// Makes a new active link, turning off any earlier one. The code is returned
// once, here, and never stored.
export async function createShareLink(store: LineupStore, settings: ShareSettings, now: Date): Promise<{ link: ShareLink; code: string }> {
  await revokeShareLinks(store, now);
  const code = newShareCode();
  const link: ShareLink = { id: randomUUID(), codeHash: hashShareCode(code), settings, createdAt: now.toISOString() };
  await store.putShareLink(link);
  return { link, code };
}

export async function revokeShareLinks(store: LineupStore, now: Date): Promise<void> {
  for (const l of await store.listShareLinks()) if (!l.revokedAt) await store.putShareLink({ ...l, revokedAt: now.toISOString() });
}

export async function updateShareSettings(store: LineupStore, settings: ShareSettings): Promise<ShareLink | null> {
  const link = activeLink(await store.listShareLinks());
  if (!link) return null;
  const next = { ...link, settings };
  await store.putShareLink(next);
  return next;
}

// The active link a code opens, or null for a malformed, unknown or turned
// off code (the page treats all three the same).
export async function findShareLink(store: LineupStore, code: string): Promise<ShareLink | null> {
  if (!SHARE_CODE.test(code)) return null;
  const link = await store.getShareLinkByHash(hashShareCode(code));
  return link && !link.revokedAt ? link : null;
}
