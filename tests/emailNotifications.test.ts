import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmailNotifier, isDigestTime } from '../src/server/email/notifier.ts';
import { resendFromEnv, type EmailMessage, type EmailSender } from '../src/server/email/sender.ts';
import { memoryEmailPreferences } from '../src/server/email/store.ts';
import { signUnsubscribe, verifyUnsubscribe } from '../src/server/email/unsubscribe.ts';
import { clearMemberCache, resolveMember, type MemberDirectory } from '../src/server/auth/members.ts';
import type { AccessRequest, AccessRequestStore, RequestSettings } from '../src/server/auth/requests.ts';
import { membersRouter } from '../src/server/auth/routes.ts';
import { accessRequestOwnerRouter } from '../src/server/auth/requestRoutes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { frontDoor } from '../src/server/share/door.ts';
import type { AccessConfig } from '../src/server/share/access.ts';

const ORIGIN = 'https://concert.charliechonguyen.com';
const SECRET = 'test-hmac-secret-key';
const OWNER = 'owner@example.com';

function recordingSender(configured = true): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    sender: {
      configured,
      async send(msg) {
        if (!configured) return { sent: false, reason: 'not_configured' };
        sent.push(msg);
        return { sent: true, id: `msg-${sent.length}` };
      },
    },
  };
}

test('digest schedule: runs once a day at 16:00 UTC', () => {
  assert.equal(isDigestTime(new Date('2026-11-01T16:00:00Z')), true);
  assert.equal(isDigestTime(new Date('2026-11-01T16:01:00Z')), false);
  assert.equal(isDigestTime(new Date('2026-11-01T03:00:00Z')), false);
});

test('daily request digest: batches new pending requests into at most 1 email per day', async () => {
  const { sender, sent } = recordingSender();
  const prefs = memoryEmailPreferences();
  let settings: RequestSettings = { paused: false, cap: 20 };
  const rows: AccessRequest[] = [
    {
      email: 'alice@example.com',
      status: 'pending',
      source: 'requested',
      requestedAt: '2026-11-01T10:00:00Z',
      statusChangedAt: '2026-11-01T10:00:00Z',
      hasAccount: false,
      blocked: false,
    },
    {
      email: 'bob@example.com',
      status: 'pending',
      source: 'requested',
      requestedAt: '2026-11-01T12:30:00Z',
      statusChangedAt: '2026-11-01T12:30:00Z',
      hasAccount: false,
      blocked: false,
    },
    {
      email: 'declined@example.com',
      status: 'declined',
      source: 'requested',
      requestedAt: '2026-11-01T11:00:00Z',
      statusChangedAt: '2026-11-01T11:05:00Z',
      hasAccount: false,
      blocked: false,
    },
  ];

  const notifier = createEmailNotifier({
    sender,
    prefs,
    requests: {
      list: async () => rows,
      settings: async () => settings,
      saveSettings: async (patch) => {
        settings = { ...settings, ...patch };
        return settings;
      },
    },
    ownerEmail: OWNER,
    secret: SECRET,
    origin: ORIGIN,
  });

  const day1 = new Date('2026-11-01T16:00:00Z');
  const first = await notifier.runDigest(day1);
  assert.deepEqual(first, { sent: true, count: 2, reason: undefined });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, OWNER);
  assert.equal(sent[0].subject, 'LiveArchive: 2 new access requests');
  assert.match(sent[0].text, /alice@example\.com/);
  assert.match(sent[0].text, /bob@example\.com/);
  assert.doesNotMatch(sent[0].text, /declined@example\.com/);
  assert.equal(settings.lastDigestAt, '2026-11-01T16:00:00.000Z');

  // Calling again the same day is refused (max 1 daily), even if a new request arrives an hour later.
  rows.push({
    email: 'charlie@example.com',
    status: 'pending',
    source: 'requested',
    requestedAt: '2026-11-01T17:00:00Z',
    statusChangedAt: '2026-11-01T17:00:00Z',
    hasAccount: false,
    blocked: false,
  });
  const sameDay = await notifier.runDigest(new Date('2026-11-01T18:00:00Z'));
  assert.equal(sameDay.sent, false);
  assert.equal(sameDay.reason, 'already_sent_today');
  assert.equal(sent.length, 1);

  // Next day at 16:00 UTC: only the 1 new request since lastDigestAt is included, with totalPending = 3.
  const day2 = new Date('2026-11-02T16:00:00Z');
  const second = await notifier.runDigest(day2);
  assert.deepEqual(second, { sent: true, count: 1, reason: undefined });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, 'LiveArchive: 1 new access request');
  assert.match(sent[1].text, /charlie@example\.com/);
  assert.doesNotMatch(sent[1].text, /alice@example\.com/);
  assert.match(sent[1].text, /Pending requests: 3 of 20 cap/);

  // Day 3 with no new requests sends nothing.
  const day3 = new Date('2026-11-03T16:00:00Z');
  const third = await notifier.runDigest(day3);
  assert.deepEqual(third, { sent: false, count: 0, reason: 'no_new_requests' });
  assert.equal(sent.length, 2);
});

test('invite and first-login welcome flow (#2 in Section 1): pre-approved invite sends #2, first login sends #3 once', async () => {
  clearMemberCache();
  const { sender, sent } = recordingSender();
  const prefs = memoryEmailPreferences();
  const notifier = createEmailNotifier({
    sender,
    prefs,
    secret: SECRET,
    origin: ORIGIN,
    now: () => new Date('2026-11-01T12:00:00Z'),
  });

  const friend = 'Friend@Example.com';
  // 1. Owner adds friend to invite list -> sends Email #2 (Invite with login instructions).
  const inviteRes = await notifier.sendInvite(friend);
  assert.equal(inviteRes.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'friend@example.com');
  assert.equal(sent[0].subject, "You're invited to LiveArchive");
  assert.match(sent[0].text, /How to sign in and get started/);
  assert.match(sent[0].text, /https:\/\/concert\.charliechonguyen\.com\/app/);
  assert.ok(sent[0].headers?.['List-Unsubscribe']?.includes('/unsubscribe?email=friend%40example.com'));
  assert.equal(sent[0].headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  // Re-inviting without resend=true does not duplicate the invite email.
  const duplicateInvite = await notifier.sendInvite(friend);
  assert.deepEqual(duplicateInvite, { sent: false, reason: 'already_sent' });
  assert.equal(sent.length, 1);

  // 2. Friend signs in for the first time -> resolveMember links userId and triggers onFirstJoin -> sends Email #3 (Welcome).
  let linkedUserId: string | null = null;
  const dir: MemberDirectory = {
    findMember: async (email) => ({ email, userId: linkedUserId, role: 'member', blocked: false }),
    createAuthUser: async () => 'auth-u-1',
    linkMember: async (_email, uid) => {
      linkedUserId = uid;
    },
    listMembers: async () => [],
    inviteMember: async () => {},
    removeMember: async () => {},
    hasActiveUser: async () => true,
    onFirstJoin: async (email) => {
      await notifier.sendWelcome(email);
    },
  };

  await resolveMember(friend, dir, 1000);
  assert.equal(linkedUserId, 'auth-u-1');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].to, 'friend@example.com');
  assert.equal(sent[1].subject, 'Welcome to LiveArchive — your archive is ready');
  assert.match(sent[1].text, /Recommended next steps/);
  assert.match(sent[1].text, /Scan your ticket emails/);

  // Subsequent sign-ins (after cache expiry) or owner clicking Accept again never send a second welcome email.
  clearMemberCache();
  await resolveMember(friend, dir, 50_000);
  const duplicateWelcome = await notifier.sendWelcome(friend);
  assert.deepEqual(duplicateWelcome, { sent: false, reason: 'already_sent' });
  assert.equal(sent.length, 2);
});

test('request approval flow: accepting a request sends welcome email #3, and first sign-in afterwards does not send a second copy', async () => {
  clearMemberCache();
  const { sender, sent } = recordingSender();
  const prefs = memoryEmailPreferences();
  const notifier = createEmailNotifier({
    sender,
    prefs,
    secret: SECRET,
    origin: ORIGIN,
  });

  const requester = 'requester@example.com';
  // Owner approves pending request -> sends Welcome email #3 immediately.
  const accepted = await notifier.sendWelcome(requester);
  assert.equal(accepted.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Welcome to LiveArchive — your archive is ready');

  // Requester opens /app for the first time as an accepted member -> onFirstJoin sees welcomeSentAt and skips.
  const dir: MemberDirectory = {
    findMember: async (email) => ({ email, userId: null, role: 'member', blocked: false }),
    createAuthUser: async () => 'auth-u-2',
    linkMember: async () => {},
    listMembers: async () => [],
    inviteMember: async () => {},
    removeMember: async () => {},
    hasActiveUser: async () => true,
    onFirstJoin: async (email) => {
      await notifier.sendWelcome(email);
    },
  };
  await resolveMember(requester, dir, 1000);
  assert.equal(sent.length, 1);
});

test('opt-out & public /unsubscribe door: works without Cloudflare Access, blocks forged tokens, and suppresses all emails', async () => {
  const { sender, sent } = recordingSender();
  const prefs = memoryEmailPreferences();
  const notifier = createEmailNotifier({
    sender,
    prefs,
    secret: SECRET,
    origin: ORIGIN,
  });
  const access: AccessConfig = { teamDomain: 'https://team.cloudflareaccess.com', aud: 'aud-1' };
  const door = (path: string, init?: RequestInit) =>
    frontDoor(new Request(`${ORIGIN}${path}`, init), {
      store: async () => ({}) as never,
      access,
      emailPrefs: async () => prefs,
      unsubscribeSecret: SECRET,
    });

  const user = 'optout@example.com';
  const sig = await signUnsubscribe(user, SECRET);
  assert.equal(await verifyUnsubscribe(user, sig, SECRET), true);
  assert.equal(await verifyUnsubscribe('other@example.com', sig, SECRET), false);
  assert.equal(await verifyUnsubscribe(user, `${sig}x`, SECRET), false);

  // Forged signature gets 400 (never 403 from Access, because /unsubscribe is public).
  const badRes = (await door(`/unsubscribe?email=${encodeURIComponent(user)}&sig=forged`))!;
  assert.equal(badRes.status, 400);
  assert.match(await badRes.text(), /isn&#39;t valid|invalid/i);

  // GET /unsubscribe with valid signature does NOT mutate state (safe against email link prefetchers).
  const getRes = (await door(`/unsubscribe?email=${encodeURIComponent(user)}&sig=${encodeURIComponent(sig)}`))!;
  assert.equal(getRes.status, 200);
  assert.equal((await prefs.getEmailPreference(user)).optedOut, false);
  assert.match(await getRes.text(), /Unsubscribe from LiveArchive emails/);

  // POST /unsubscribe (RFC 8058 One-Click or form submit) opts the user out.
  const postRes = (await door(`/unsubscribe?email=${encodeURIComponent(user)}&sig=${encodeURIComponent(sig)}`, {
    method: 'POST',
    body: 'List-Unsubscribe=One-Click',
  }))!;
  assert.equal(postRes.status, 200);
  assert.equal((await prefs.getEmailPreference(user)).optedOut, true);
  assert.match(await postRes.text(), /You're unsubscribed/);

  // While opted out, invite and welcome emails are suppressed.
  assert.deepEqual(await notifier.sendInvite(user), { sent: false, reason: 'opted_out' });
  assert.deepEqual(await notifier.sendWelcome(user), { sent: false, reason: 'opted_out' });
  assert.equal(sent.length, 0);

  // Re-subscribing via POST action=resubscribe restores email delivery.
  const resubRes = (await door(`/unsubscribe?email=${encodeURIComponent(user)}&sig=${encodeURIComponent(sig)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=resubscribe',
  }))!;
  assert.equal(resubRes.status, 200);
  assert.equal((await prefs.getEmailPreference(user)).optedOut, false);
  assert.equal((await notifier.sendInvite(user)).sent, true);
  assert.equal(sent.length, 1);
});

test('resendFromEnv: sends payload to Resend API and never throws on missing key or HTTP failure', async () => {
  const unconfigured = resendFromEnv({});
  assert.equal(unconfigured.configured, false);
  assert.equal((await unconfigured.send({ to: 'a@b.c', subject: 's', text: 't', html: '<p>t</p>' })).sent, false);

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const configured = resendFromEnv(
    { RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'LiveArchive <no-reply@mail.example.com>', OWNER_EMAIL: OWNER },
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 're-id-1' }), { status: 200 });
    }) as unknown as typeof fetch,
  );
  assert.equal(configured.configured, true);
  const ok = await configured.send({
    to: 'friend@example.com',
    subject: 'Hi',
    text: 'Plain',
    html: '<p>HTML</p>',
    headers: { 'List-Unsubscribe': '<https://example.com/u>' },
  });
  assert.deepEqual(ok, { sent: true, id: 're-id-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.from, 'LiveArchive <no-reply@mail.example.com>');
  assert.deepEqual(body.to, ['friend@example.com']);
  assert.equal(body.reply_to, OWNER);
  assert.equal(body.headers['List-Unsubscribe'], '<https://example.com/u>');
});

test('routes: POST /members sends invite email, PUT /access-requests/:email sends welcome email, and /me/email-prefs toggles opt-out', async () => {
  const { sender, sent } = recordingSender();
  const prefs = memoryEmailPreferences();
  const notifier = createEmailNotifier({
    sender,
    prefs,
    secret: SECRET,
    origin: ORIGIN,
  });

  const invited: string[] = [];
  const statuses: Array<[string, string]> = [];
  const dir: MemberDirectory = {
    findMember: async () => null,
    createAuthUser: async (e) => `u-${e}`,
    linkMember: async () => {},
    listMembers: async () => [],
    inviteMember: async (e) => {
      invited.push(e);
    },
    removeMember: async () => {},
    hasActiveUser: async () => true,
  };
  const reqStore: AccessRequestStore = {
    submit: async () => 'sent',
    view: async () => 'none',
    list: async () => [],
    pendingCount: async () => 0,
    settings: async () => ({ paused: false, cap: 20 }),
    saveSettings: async (p) => ({ paused: false, cap: 20, ...p }),
    setStatus: async (e, to) => {
      statuses.push([e, to]);
    },
  };

  const mRouter = membersRouter(dir, {} as any, reqStore, notifier);
  const rRouter = accessRequestOwnerRouter(reqStore, notifier);

  const invoke = (router: any, member: { email: string; userId: string; role: 'owner' | 'member' }, method: string, url: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req: any = { method, url, originalUrl: url, path: url, params: {}, body: body ?? {}, headers: {}, get: () => undefined };
      const res: any = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        set() {
          return this;
        },
        json(payload: unknown) {
          resolve({ status: this.statusCode, body: payload });
          return this;
        },
      };
      runAsMember(member, {} as any, () => {
        router.handle(req, res, (err: unknown) => (err ? reject(err) : resolve({ status: 404, body: null })));
      });
    });

  const owner = { email: OWNER, userId: 'u-owner', role: 'owner' as const };
  const member = { email: 'maya@example.com', userId: 'u-maya', role: 'member' as const };

  // 1. Invite with sendEmail default (true) -> sends invite email.
  const inv1 = await invoke(mRouter, owner, 'POST', '/members', { email: 'newfriend@example.com' });
  assert.equal(inv1.status, 201);
  assert.deepEqual(inv1.body, { ok: true, emailSent: true });
  assert.deepEqual(invited, ['newfriend@example.com']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'newfriend@example.com');

  // 1b. Duplicate invite without resend -> already_sent
  const invDup = await invoke(mRouter, owner, 'POST', '/members', { email: 'newfriend@example.com' });
  assert.equal(invDup.status, 201);
  assert.deepEqual(invDup.body, { ok: true, emailSent: false, emailReason: 'already_sent' });
  assert.equal(sent.length, 1);

  // 1c. Manual resend invite with resend: true -> sends invite email again
  const invResend = await invoke(mRouter, owner, 'POST', '/members', { email: 'newfriend@example.com', resend: true });
  assert.equal(invResend.status, 201);
  assert.deepEqual(invResend.body, { ok: true, emailSent: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].to, 'newfriend@example.com');

  // 2. Invite with sendEmail: false -> adds member without sending email.
  const inv2 = await invoke(mRouter, owner, 'POST', '/members', { email: 'quiet@example.com', sendEmail: false });
  assert.equal(inv2.status, 201);
  assert.deepEqual(inv2.body, { ok: true });
  assert.equal(sent.length, 2);

  // 3. Accept request -> sends welcome email.
  const acc = await invoke(rRouter, owner, 'PUT', '/access-requests/pending%40example.com', { to: 'accepted' });
  assert.equal(acc.status, 200);
  assert.deepEqual(acc.body, { ok: true, emailSent: true });
  assert.deepEqual(statuses, [['pending@example.com', 'accepted']]);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].to, 'pending@example.com');
  assert.match(sent[2].subject, /Welcome to LiveArchive/);

  // 4. Member reads and updates their own email preferences in-app.
  const getPref = await invoke(mRouter, member, 'GET', '/me/email-prefs');
  assert.equal(getPref.status, 200);
  assert.equal(getPref.body.optedOut, false);

  const putPref = await invoke(mRouter, member, 'PUT', '/me/email-prefs', { optedOut: true });
  assert.equal(putPref.status, 200);
  assert.equal(putPref.body.optedOut, true);
  assert.ok(putPref.body.optedOutAt);
});

