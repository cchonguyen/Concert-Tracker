import type { AccessRequestStore } from '../auth/requests';
import { SITE_ORIGIN } from '../site/publicPaths';
import type { EmailSender } from './sender';
import type { EmailPreference, EmailPreferenceStore } from './store';
import { buildDigestEmail, buildInviteEmail, buildWelcomeEmail } from './templates';
import { signUnsubscribe, unsubscribeHeaders, unsubscribeUrl } from './unsubscribe';

// Coordinates all three outbound emails (daily owner request digest, invite
// email, approval/first-join welcome email) with opt-out checks, idempotency
// tracking and RFC 8058 List-Unsubscribe headers.

const DAY_MS = 24 * 60 * 60 * 1000;

// The Worker's cron runs every minute. The daily request digest runs at 16:00 UTC (8:00 AM PST).
export function isDigestTime(now: Date): boolean {
  return now.getUTCHours() === 16 && now.getUTCMinutes() === 0;
}

export interface EmailNotifyResult {
  sent: boolean;
  reason?: string;
}

export interface DigestRunResult {
  sent: boolean;
  count: number;
  reason?: string;
}

export interface EmailNotifier {
  readonly configured: boolean;
  sendInvite(email: string, opts?: { resend?: boolean }): Promise<EmailNotifyResult>;
  sendWelcome(email: string): Promise<EmailNotifyResult>;
  runDigest(now?: Date): Promise<DigestRunResult>;
  getPreference(email: string): Promise<EmailPreference>;
  setOptOut(email: string, optedOut: boolean): Promise<EmailPreference>;
}

export interface CreateEmailNotifierDeps {
  sender: EmailSender;
  prefs: EmailPreferenceStore;
  requests?: Pick<AccessRequestStore, 'list' | 'settings' | 'saveSettings'>;
  ownerEmail?: string | null;
  secret: string | null;
  origin?: string;
  now?: () => Date;
}

export function createEmailNotifier(deps: CreateEmailNotifierDeps): EmailNotifier {
  const origin = deps.origin ?? SITE_ORIGIN;
  const nowFn = deps.now ?? (() => new Date());

  const makeUnsubscribe = async (email: string) => {
    if (!deps.secret) throw new Error('Unsubscribe secret is required');
    const sig = await signUnsubscribe(email, deps.secret);
    const link = unsubscribeUrl(origin, email, sig);
    return { link, headers: unsubscribeHeaders(link) };
  };

  return {
    get configured() {
      return deps.sender.configured;
    },

    async getPreference(email) {
      return deps.prefs.getEmailPreference(email);
    },

    async setOptOut(email, optedOut) {
      return deps.prefs.setEmailOptOut(email, optedOut, nowFn().toISOString());
    },

    async sendInvite(rawEmail, opts) {
      const email = rawEmail.trim().toLowerCase();
      try {
        const pref = await deps.prefs.getEmailPreference(email);
        if (pref.optedOut) return { sent: false, reason: 'opted_out' };
        if (pref.inviteSentAt && !opts?.resend) return { sent: false, reason: 'already_sent' };
        if (!deps.sender.configured) return { sent: false, reason: 'not_configured' };

        const { link, headers } = await makeUnsubscribe(email);
        const built = buildInviteEmail({ origin, email, unsubscribeLink: link });
        const res = await deps.sender.send({ to: email, ...built, headers });
        if (res.sent) {
          await deps.prefs.markEmailSent(email, 'invite', nowFn().toISOString());
        }
        return res;
      } catch (err) {
        return { sent: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async sendWelcome(rawEmail) {
      const email = rawEmail.trim().toLowerCase();
      try {
        const pref = await deps.prefs.getEmailPreference(email);
        if (pref.optedOut) return { sent: false, reason: 'opted_out' };
        if (pref.welcomeSentAt) return { sent: false, reason: 'already_sent' };
        if (!deps.sender.configured) return { sent: false, reason: 'not_configured' };

        const { link, headers } = await makeUnsubscribe(email);
        const built = buildWelcomeEmail({ origin, email, unsubscribeLink: link });
        const res = await deps.sender.send({ to: email, ...built, headers });
        if (res.sent) {
          await deps.prefs.markEmailSent(email, 'welcome', nowFn().toISOString());
        }
        return res;
      } catch (err) {
        return { sent: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async runDigest(now = nowFn()) {
      const ownerEmail = deps.ownerEmail?.trim().toLowerCase() ?? '';
      if (!deps.requests) return { sent: false, count: 0, reason: 'no_request_store' };
      if (!ownerEmail) return { sent: false, count: 0, reason: 'no_owner_email' };

      try {
        const [rows, settings] = await Promise.all([deps.requests.list(), deps.requests.settings()]);
        const lastDigestMs = settings.lastDigestAt ? Date.parse(settings.lastDigestAt) : 0;
        // Max 1 daily guard: even if called more than once, refuse within 23 hours of lastDigestAt.
        if (Number.isFinite(lastDigestMs) && lastDigestMs > 0 && now.getTime() - lastDigestMs < 23 * 60 * 60 * 1000) {
          return { sent: false, count: 0, reason: 'already_sent_today' };
        }

        const pending = rows.filter((r) => r.status === 'pending');
        const newRequests = pending.filter((r) => {
          const t = Date.parse(r.requestedAt);
          return !Number.isFinite(lastDigestMs) || lastDigestMs <= 0 ? true : Number.isFinite(t) && t > lastDigestMs;
        });

        if (newRequests.length === 0) {
          return { sent: false, count: 0, reason: 'no_new_requests' };
        }

        const pref = await deps.prefs.getEmailPreference(ownerEmail);
        if (pref.optedOut) {
          await deps.requests.saveSettings({ lastDigestAt: now.toISOString() });
          return { sent: false, count: newRequests.length, reason: 'opted_out' };
        }
        if (!deps.sender.configured) {
          return { sent: false, count: newRequests.length, reason: 'not_configured' };
        }

        const { link, headers } = await makeUnsubscribe(ownerEmail);
        const built = buildDigestEmail({
          origin,
          newRequests: newRequests.map((r) => ({ email: r.email, requestedAt: r.requestedAt })),
          totalPending: pending.length,
          cap: settings.cap,
          unsubscribeLink: link,
        });
        const res = await deps.sender.send({ to: ownerEmail, ...built, headers });
        if (res.sent) {
          await deps.requests.saveSettings({ lastDigestAt: now.toISOString() });
        }
        return { sent: res.sent, count: newRequests.length, reason: res.reason };
      } catch (err) {
        // Keep the error non-throwing so the Worker cron continues to queue jobs.
        return { sent: false, count: 0, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
