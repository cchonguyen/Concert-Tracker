import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAccessRequests, type AccessRequestStore } from './requests';

// Who may use the app. Cloudflare Access decides who can sign in; this list
// decides who has a tracker. A member is invited by email (the `members`
// table, migration 0017). The first time they sign in, a Supabase Auth user
// is made for them and linked, so their rows can carry its id. Nobody
// signs up: an email not on the list gets "not invited", or may ask for
// access (requests.ts). A blocked member keeps their rows and is refused.

export type MemberRole = 'owner' | 'member';

export interface Member {
  email: string;
  userId: string | null;
  role: MemberRole;
}

export interface MemberDirectory {
  findMember(email: string): Promise<(Member & { blocked?: boolean }) | null>;
  createAuthUser(email: string): Promise<string>;
  linkMember(email: string, userId: string): Promise<void>;
  listMembers(): Promise<Array<Member & { invitedAt: string; blocked?: boolean }>>;
  // Adds the member and marks their request accepted (invited), in one call.
  inviteMember(email: string): Promise<void>;
  // Removes the member's Supabase Auth user; their rows go with it (user_id
  // references auth.users on delete cascade). Then the request history is set:
  // declined when the owner deletes, left when the member leaves.
  removeMember(email: string, by?: 'owner' | 'self'): Promise<void>;
  // False for a removed or blocked member. runJob parks their jobs (src/server/lineup/pipeline.ts).
  hasActiveUser(userId: string): Promise<boolean>;
}

export interface SignedInMember {
  email: string;
  userId: string;
  role: MemberRole;
}

export class NotInvitedError extends Error {
  constructor(readonly email = '') {
    super('This account is not invited.');
  }
}

// Members found in the last few seconds, per isolate, so a request usually
// costs no lookup. A removed or blocked member keeps access for at most this
// long on other isolates; the isolate that made the change clears its entry.
// Refusals are never cached.
const CACHE_MS = 15_000;
const cache = new Map<string, { member: SignedInMember; until: number }>();
export const clearMemberCache = (email?: string) => (email ? cache.delete(email.trim().toLowerCase()) : cache.clear());

export async function resolveMember(email: string, dir: MemberDirectory, now = Date.now()): Promise<SignedInMember> {
  const key = email.trim().toLowerCase();
  if (!key) throw new NotInvitedError(key);
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.member;
  const found = await dir.findMember(key);
  if (!found || found.blocked) throw new NotInvitedError(key);
  let userId = found.userId;
  if (!userId) {
    userId = await dir.createAuthUser(key);
    await dir.linkMember(key, userId);
  }
  const member: SignedInMember = { email: key, userId, role: found.role };
  cache.set(key, { member, until: now + CACHE_MS });
  return member;
}

// The members table read and written with the service key; nobody else can
// read it (RLS on, no policies).
export function supabaseMemberDirectory(db: SupabaseClient): MemberDirectory {
  return {
    async findMember(email) {
      const { data, error } = await db.from('members').select('email, user_id, role, blocked').eq('email', email).maybeSingle();
      if (error) throw new Error(`members: ${error.message} (apply 0017_members_and_user_id.sql)`);
      return data ? { email: data.email, userId: data.user_id ?? null, role: data.role, blocked: Boolean(data.blocked) } : null;
    },
    async createAuthUser(email) {
      const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
      if (error || !data.user) throw new Error(`Could not create the sign-in for ${email}: ${error?.message ?? 'no user returned'}`);
      return data.user.id;
    },
    async linkMember(email, userId) {
      const { error } = await db.from('members').update({ user_id: userId }).eq('email', email).is('user_id', null);
      if (error) throw new Error(`members: ${error.message}`);
    },
    async listMembers() {
      const { data, error } = await db.from('members').select('email, user_id, role, blocked, invited_at').order('invited_at');
      if (error) throw new Error(`members: ${error.message}`);
      return (data ?? []).map((r: any) => ({ email: r.email, userId: r.user_id ?? null, role: r.role, blocked: Boolean(r.blocked), invitedAt: r.invited_at }));
    },
    async inviteMember(email) {
      const { error } = await db.rpc('access_request_set', { p_email: email, p_to: 'accepted', p_new_source: 'invited' });
      if (error) throw new Error(error.message);
    },
    async hasActiveUser(userId) {
      const { data, error } = await db.from('members').select('blocked').eq('user_id', userId).maybeSingle();
      if (error) throw new Error(`members: ${error.message}`);
      return Boolean(data) && !data!.blocked;
    },
    async removeMember(email, by = 'owner') {
      const { data, error } = await db.from('members').select('user_id, role').eq('email', email).maybeSingle();
      if (error) throw new Error(`members: ${error.message}`);
      if (!data) return;
      if (data.role === 'owner') throw new Error('The owner cannot be removed.');
      // Deleting the Auth user cascades to members and every personal row. If the
      // second step below fails, the request row still says accepted with no
      // account; the owner's panel shows that, and removing again fixes it.
      if (data.user_id) {
        const { error: delErr } = await db.auth.admin.deleteUser(data.user_id);
        if (delErr) throw new Error(`Could not remove the account: ${delErr.message}`);
      } else {
        const { error: delErr } = await db.from('members').delete().eq('email', email);
        if (delErr) throw new Error(`members: ${delErr.message}`);
      }
      const { error: histErr } = await db.rpc('access_request_removed', { p_email: email, p_by: by });
      if (histErr) throw new Error(`access_requests: ${histErr.message}`);
    },
  };
}

// The directory and the request store, both on the service key (one client).
export function supabaseMemberStores(db: SupabaseClient): MemberDirectory & AccessRequestStore {
  return { ...supabaseMemberDirectory(db), ...supabaseAccessRequests(db) };
}
