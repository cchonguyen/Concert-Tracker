import type { SupabaseClient } from '@supabase/supabase-js';

// Request access (migration 0024, ARCHITECTURE.md "Request access"). A signed-in
// Google account with no members row may ask for a tracker. The owner sees the
// history here and switches each email's status. Every change goes through a
// database function, so access_requests and members change together.

export type RequestStatus = 'pending' | 'accepted' | 'declined' | 'left';
export type RequestSource = 'requested' | 'invited' | 'blocked';

export interface AccessRequest {
  email: string;
  status: RequestStatus;
  source: RequestSource;
  requestedAt: string;
  statusChangedAt: string;
  // Whether a members row exists (false for pending, left, and a row whose
  // data was deleted but whose history step failed: "accepted (no account)").
  hasAccount: boolean;
  blocked: boolean;
}

export interface RequestSettings {
  paused: boolean;
  cap: number;
  lastDigestAt?: string;
}

// What a non-member's request may get back. "closed" covers the pause and a full pending list.
export type SubmitState = 'sent' | 'closed';
export type ViewState = 'none' | 'sent' | 'closed';

export const DEFAULT_SETTINGS: RequestSettings = { paused: false, cap: 20 };
export const CAP_RANGE = { min: 1, max: 100 } as const;
const SETTINGS_KEY = 'access_requests';

export interface AccessRequestStore {
  submit(email: string, sub: string | null): Promise<SubmitState>;
  view(email: string, sub: string | null): Promise<ViewState>;
  list(): Promise<AccessRequest[]>;
  pendingCount(): Promise<number>;
  settings(): Promise<RequestSettings>;
  saveSettings(patch: Partial<RequestSettings>): Promise<RequestSettings>;
  // Any status to pending, accepted or declined. A new email starts as invited (accepted) or blocked (declined).
  setStatus(email: string, to: 'pending' | 'accepted' | 'declined'): Promise<void>;
}

// Validates a settings change. Returns the cleaned patch, or throws a message for the owner.
export function cleanSettingsPatch(body: unknown): Partial<RequestSettings> {
  const out: Partial<RequestSettings> = {};
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.paused !== undefined) {
    if (typeof b.paused !== 'boolean') throw new Error('paused must be on or off.');
    out.paused = b.paused;
  }
  if (b.cap !== undefined) {
    if (!Number.isInteger(b.cap) || (b.cap as number) < CAP_RANGE.min || (b.cap as number) > CAP_RANGE.max) {
      throw new Error(`The pending cap must be a whole number from ${CAP_RANGE.min} to ${CAP_RANGE.max}.`);
    }
    out.cap = b.cap as number;
  }
  return out;
}

export function supabaseAccessRequests(db: SupabaseClient): AccessRequestStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(error.message.includes('does not exist') ? `${fn}: apply 0024_access_requests.sql` : error.message);
    return data as T;
  };
  const settings = async (): Promise<RequestSettings> => {
    const { data, error } = await db.from('app_settings').select('data').eq('key', SETTINGS_KEY).maybeSingle();
    if (error) throw new Error(`app_settings: ${error.message}`);
    return { ...DEFAULT_SETTINGS, ...(data?.data ?? {}) } as RequestSettings;
  };
  return {
    submit: (email, sub) => rpc<SubmitState>('access_request_submit', { p_email: email, p_sub: sub }),
    view: (email, sub) => rpc<ViewState>('access_request_state', { p_email: email, p_sub: sub }),
    async list() {
      const [rows, members] = await Promise.all([
        db.from('access_requests').select('email, status, source, requested_at, status_changed_at').order('requested_at', { ascending: false }),
        db.from('members').select('email, blocked'),
      ]);
      if (rows.error) throw new Error(`access_requests: ${rows.error.message} (apply 0024_access_requests.sql)`);
      if (members.error) throw new Error(`members: ${members.error.message}`);
      const byEmail = new Map((members.data ?? []).map((m: any) => [m.email, m]));
      return (rows.data ?? []).map((r: any) => ({
        email: r.email,
        status: r.status,
        source: r.source,
        requestedAt: r.requested_at,
        statusChangedAt: r.status_changed_at,
        hasAccount: byEmail.has(r.email),
        blocked: Boolean(byEmail.get(r.email)?.blocked),
      }));
    },
    async pendingCount() {
      const { count, error } = await db.from('access_requests').select('email', { count: 'exact', head: true }).eq('status', 'pending');
      if (error) throw new Error(`access_requests: ${error.message}`);
      return count ?? 0;
    },
    settings,
    async saveSettings(patch) {
      const next = { ...(await settings()), ...patch };
      const { error } = await db.from('app_settings').upsert({ key: SETTINGS_KEY, data: next, updated_at: new Date().toISOString() });
      if (error) throw new Error(`app_settings: ${error.message}`);
      return next;
    },
    async setStatus(email, to) {
      const newSource = to === 'accepted' ? 'invited' : 'blocked';
      await rpc('access_request_set', { p_email: email, p_to: to, p_new_source: newSource });
    },
  };
}
