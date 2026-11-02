// Outbound email sender (Resend REST API, zero external SDK dependencies).
// When RESEND_API_KEY is not configured, send() returns { sent: false } and
// never throws, so member invites, approvals and sign-ins work without email.

export const DEFAULT_EMAIL_FROM = 'LiveArchive <notifications@mail.charliechonguyen.com>';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  replyTo?: string;
}

export interface EmailSendResult {
  sent: boolean;
  id?: string;
  reason?: string;
}

export interface EmailSender {
  readonly configured: boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export function noopEmailSender(reason = 'Email is not configured (set RESEND_API_KEY).'): EmailSender {
  return {
    configured: false,
    async send() {
      return { sent: false, reason };
    },
  };
}

export function resendFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): EmailSender {
  const apiKey = env.RESEND_API_KEY?.trim() ?? '';
  if (!apiKey) return noopEmailSender();
  const from = env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM;
  const defaultReplyTo = env.CONTACT_EMAIL?.trim() || env.OWNER_EMAIL?.trim() || undefined;

  return {
    configured: true,
    async send(message) {
      try {
        const replyTo = message.replyTo ?? defaultReplyTo;
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(message.headers ? { headers: message.headers } : {}),
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
        if (!res.ok) {
          return { sent: false, reason: body.message || `Resend answered HTTP ${res.status}.` };
        }
        return { sent: true, id: body.id };
      } catch (err) {
        return { sent: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
