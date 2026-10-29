import type { SupabaseClient } from '@supabase/supabase-js';

// Who may use the app. Cloudflare Access decides who can sign in; this list
// decides who has a tracker. A member is invited by email (the `members`
// table, migration 0017). The first time they sign in, a Supabase Auth user
// is made for them and linked, so their rows can carry its id. Nobody
// signs up: an email not on the list gets "not invited".

export type MemberRole = 'owner' | 'member';

export interface Member {
  email: string;
  userId: string | null;
  role: MemberRole;
}

export interface MemberDirectory {
  findMember(email: string): Promise<Member | null>;
  createAuthUser(email: string): Promise<string>;
  linkMember(email: string, userId: string): Promise<void>;
  listMembers(): Promise<Array<Member & { invitedAt: string }>>;
  inviteMember(email: string): Promise<void>;
  // Removes the invite and the member's Supabase Auth user; their rows go
  // with it (user_id references auth.users on delete cascade).
  removeMember(email: string): Promise<void>;
}

export interface SignedInMember {
  email: string;
  userId: string;
  role: MemberRole;
}

export class NotInvitedError extends Error {
  constructor() {
    super('This account is not invited.');
  }
}

// Members found in the last few minutes, per isolate, so a request usually
// costs no lookup. A removed member keeps access for at most this long.
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { member: SignedInMember; until: number }>();
export const clearMemberCache = (email?: string) => (email ? cache.delete(email.trim().toLowerCase()) : cache.clear());

export async function resolveMember(email: string, dir: MemberDirectory, now = Date.now()): Promise<SignedInMember> {
  const key = email.trim().toLowerCase();
  if (!key) throw new NotInvitedError();
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.member;
  const found = await dir.findMember(key);
  if (!found) throw new NotInvitedError();
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
      const { data, error } = await db.from('members').select('email, user_id, role').eq('email', email).maybeSingle();
      if (error) throw new Error(`members: ${error.message} (apply 0017_members_and_user_id.sql)`);
      return data ? { email: data.email, userId: data.user_id ?? null, role: data.role } : null;
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
      const { data, error } = await db.from('members').select('email, user_id, role, invited_at').order('invited_at');
      if (error) throw new Error(`members: ${error.message}`);
      return (data ?? []).map((r: any) => ({ email: r.email, userId: r.user_id ?? null, role: r.role, invitedAt: r.invited_at }));
    },
    async inviteMember(email) {
      const { error } = await db.from('members').insert({ email, role: 'member' });
      if (error) throw new Error(error.code === '23505' ? 'That email is already invited.' : `members: ${error.message}`);
    },
    async removeMember(email) {
      const { data, error } = await db.from('members').select('user_id, role').eq('email', email).maybeSingle();
      if (error) throw new Error(`members: ${error.message}`);
      if (!data) return;
      if (data.role === 'owner') throw new Error('The owner cannot be removed.');
      // Deleting the Auth user cascades to members and every personal row.
      if (data.user_id) {
        const { error: delErr } = await db.auth.admin.deleteUser(data.user_id);
        if (delErr) throw new Error(`Could not remove the account: ${delErr.message}`);
      } else {
        const { error: delErr } = await db.from('members').delete().eq('email', email);
        if (delErr) throw new Error(`members: ${delErr.message}`);
      }
    },
  };
}
