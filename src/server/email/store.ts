import type { SupabaseClient } from '@supabase/supabase-js';

// Email preferences and sent-email timestamps (migration 0028_email_notifications.sql).
// Every outbound email checks optedOut first; inviteSentAt and welcomeSentAt
// ensure re-inviting or re-accepting a member does not send duplicate emails.

export interface EmailPreference {
  email: string;
  optedOut: boolean;
  optedOutAt: string | null;
  inviteSentAt: string | null;
  welcomeSentAt: string | null;
}

export interface EmailPreferenceStore {
  getEmailPreference(email: string): Promise<EmailPreference>;
  setEmailOptOut(email: string, optedOut: boolean, now?: string): Promise<EmailPreference>;
  markEmailSent(email: string, kind: 'invite' | 'welcome', now?: string): Promise<void>;
}

const cleanEmail = (email: string) => email.trim().toLowerCase();

const emptyPref = (email: string): EmailPreference => ({
  email: cleanEmail(email),
  optedOut: false,
  optedOutAt: null,
  inviteSentAt: null,
  welcomeSentAt: null,
});

export function memoryEmailPreferences(initial: Record<string, Partial<EmailPreference>> = {}): EmailPreferenceStore {
  const rows = new Map<string, EmailPreference>();
  for (const [k, v] of Object.entries(initial)) {
    const key = cleanEmail(k);
    rows.set(key, { ...emptyPref(key), ...v, email: key });
  }
  return {
    async getEmailPreference(email) {
      const key = cleanEmail(email);
      return { ...(rows.get(key) ?? emptyPref(key)) };
    },
    async setEmailOptOut(email, optedOut, now = new Date().toISOString()) {
      const key = cleanEmail(email);
      const current = rows.get(key) ?? emptyPref(key);
      const next: EmailPreference = {
        ...current,
        optedOut: Boolean(optedOut),
        optedOutAt: optedOut ? now : null,
      };
      rows.set(key, next);
      return { ...next };
    },
    async markEmailSent(email, kind, now = new Date().toISOString()) {
      const key = cleanEmail(email);
      const current = rows.get(key) ?? emptyPref(key);
      const next: EmailPreference = {
        ...current,
        ...(kind === 'invite' ? { inviteSentAt: now } : { welcomeSentAt: now }),
      };
      rows.set(key, next);
    },
  };
}

export function supabaseEmailPreferences(db: SupabaseClient): EmailPreferenceStore {
  const toPref = (email: string, row: any): EmailPreference =>
    row
      ? {
          email: row.email,
          optedOut: Boolean(row.opted_out),
          optedOutAt: row.opted_out_at ?? null,
          inviteSentAt: row.invite_sent_at ?? null,
          welcomeSentAt: row.welcome_sent_at ?? null,
        }
      : emptyPref(email);

  return {
    async getEmailPreference(email) {
      const key = cleanEmail(email);
      const { data, error } = await db
        .from('email_preferences')
        .select('email, opted_out, opted_out_at, invite_sent_at, welcome_sent_at')
        .eq('email', key)
        .maybeSingle();
      if (error) {
        if (error.message.includes('does not exist')) {
          throw new Error(`email_preferences: ${error.message} (apply 0028_email_notifications.sql)`);
        }
        throw new Error(`email_preferences: ${error.message}`);
      }
      return toPref(key, data);
    },
    async setEmailOptOut(email, optedOut, now = new Date().toISOString()) {
      const key = cleanEmail(email);
      const current = await this.getEmailPreference(key);
      const optedOutAt = optedOut ? now : null;
      const { error } = await db.from('email_preferences').upsert({
        email: key,
        opted_out: Boolean(optedOut),
        opted_out_at: optedOutAt,
        invite_sent_at: current.inviteSentAt,
        welcome_sent_at: current.welcomeSentAt,
        updated_at: now,
      });
      if (error) throw new Error(`email_preferences: ${error.message}`);
      return { ...current, optedOut: Boolean(optedOut), optedOutAt };
    },
    async markEmailSent(email, kind, now = new Date().toISOString()) {
      const key = cleanEmail(email);
      const current = await this.getEmailPreference(key);
      const { error } = await db.from('email_preferences').upsert({
        email: key,
        opted_out: current.optedOut,
        opted_out_at: current.optedOutAt,
        invite_sent_at: kind === 'invite' ? now : current.inviteSentAt,
        welcome_sent_at: kind === 'welcome' ? now : current.welcomeSentAt,
        updated_at: now,
      });
      if (error) throw new Error(`email_preferences: ${error.message}`);
    },
  };
}
