import { escapeHtml } from '../share/page';

// Plain-text and minimal HTML templates for the 3 outbound emails:
// 1. Daily access request digest (to the owner, max 1/day)
// 2. Added to the invite list (to the invited user, with sign-in instructions)
// 3. Account approved / welcome (to the member, with recommended next steps)

export interface DigestRequestItem {
  email: string;
  requestedAt: string;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

const formatDay = (iso: string): string => {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toISOString().slice(0, 10);
};

const wrapHtml = (title: string, bodyHtml: string, unsubscribeLink: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:24px 16px;background:#0e0e11;color:#ededf0;font:15px/1.6 'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#141418;border:1px solid #3d3d46;border-radius:12px;padding:24px;">
      ${bodyHtml}
      <hr style="border:0;border-top:1px solid #2a2a31;margin:24px 0 16px;" />
      <p style="margin:0;font-size:12px;color:#a1a1aa;">
        Sent by LiveArchive. Don't want emails from LiveArchive?
        <a href="${escapeHtml(unsubscribeLink)}" style="color:#c4b5fd;text-decoration:underline;">Unsubscribe in one click</a>.
      </p>
    </div>
  </body>
</html>`;

export function buildDigestEmail(opts: {
  origin: string;
  newRequests: DigestRequestItem[];
  totalPending: number;
  cap: number;
  unsubscribeLink: string;
}): BuiltEmail {
  const count = opts.newRequests.length;
  const appUrl = `${opts.origin.replace(/\/+$/, '')}/app`;
  const subject = `LiveArchive: ${count} new access ${count === 1 ? 'request' : 'requests'}`;

  const textLines = [
    `${count} new ${count === 1 ? 'person asked' : 'people asked'} for access to LiveArchive:`,
    '',
    ...opts.newRequests.map((r) => `- ${r.email} (asked ${formatDay(r.requestedAt)})`),
    '',
    `Pending requests: ${opts.totalPending} of ${opts.cap} cap.`,
    `Review in LiveArchive (Menu -> Members -> Requests): ${appUrl}`,
    '',
    '---',
    `Unsubscribe from LiveArchive emails: ${opts.unsubscribeLink}`,
  ];

  const htmlItems = opts.newRequests
    .map(
      (r) =>
        `<li style="margin:0 0 6px;"><strong style="color:#ededf0;">${escapeHtml(r.email)}</strong> <span style="color:#a1a1aa;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">(asked ${escapeHtml(formatDay(r.requestedAt))})</span></li>`,
    )
    .join('');

  const html = wrapHtml(
    subject,
    [
      `<h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:22px;margin:0 0 12px;color:#ededf0;">${escapeHtml(subject)}</h1>`,
      `<p style="margin:0 0 12px;color:#a1a1aa;">${count === 1 ? 'A new person asked' : `${count} new people asked`} for a tracker:</p>`,
      `<ul style="margin:0 0 16px;padding-left:20px;">${htmlItems}</ul>`,
      `<p style="margin:0 0 20px;font-size:13px;color:#a1a1aa;">Pending requests: <strong style="color:#ededf0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${opts.totalPending}</strong> of ${opts.cap} cap.</p>`,
      `<p style="margin:0;"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#a78bfa;color:#0e0e11;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;">Review requests in LiveArchive</a></p>`,
    ].join(''),
    opts.unsubscribeLink,
  );

  return { subject, text: textLines.join('\n'), html };
}

export function buildInviteEmail(opts: {
  origin: string;
  email: string;
  unsubscribeLink: string;
}): BuiltEmail {
  const appUrl = `${opts.origin.replace(/\/+$/, '')}/app`;
  const subject = `You're invited to LiveArchive`;

  const text = [
    `You've been added to the invite list for LiveArchive — a private log to remember which concerts and festivals you went to and who you saw there.`,
    '',
    `How to sign in and get started:`,
    `1. Open ${appUrl}`,
    `2. Sign in through Cloudflare Access using this email address (${opts.email}).`,
    `3. Your personal archive will open right away (or if prompted on the banner, click "Request access" to link your sign-in).`,
    '',
    `Privacy: Your events, ticket email scans, share link, and notes are yours alone. Nobody else—including the site owner—can see your archive.`,
    '',
    '---',
    `Unsubscribe from LiveArchive emails: ${opts.unsubscribeLink}`,
  ].join('\n');

  const html = wrapHtml(
    subject,
    [
      `<h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:22px;margin:0 0 12px;color:#ededf0;">You're invited to LiveArchive</h1>`,
      `<p style="margin:0 0 16px;color:#ededf0;">You've been added to the invite list for <strong>LiveArchive</strong> — a private log to remember which concerts and festivals you went to and who you saw there.</p>`,
      `<h2 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:17px;margin:20px 0 8px;color:#ededf0;">How to sign in and get started</h2>`,
      `<ol style="margin:0 0 20px;padding-left:20px;color:#ededf0;">`,
      `<li style="margin:0 0 8px;">Open <a href="${escapeHtml(appUrl)}" style="color:#c4b5fd;">${escapeHtml(appUrl)}</a></li>`,
      `<li style="margin:0 0 8px;">Sign in through Cloudflare Access using <strong>${escapeHtml(opts.email)}</strong>.</li>`,
      `<li style="margin:0;">Your personal archive will open right away (or if prompted on the banner, click <strong>Request access</strong> to finish linking your sign-in).</li>`,
      `</ol>`,
      `<p style="margin:0 0 20px;"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#a78bfa;color:#0e0e11;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;">Sign in to LiveArchive</a></p>`,
      `<p style="margin:0;font-size:13px;color:#a1a1aa;"><strong>Privacy:</strong> Your events, ticket imports, share link, and notes are yours alone. Nobody else—including the site owner—can see your archive.</p>`,
    ].join(''),
    opts.unsubscribeLink,
  );

  return { subject, text, html };
}

export function buildWelcomeEmail(opts: {
  origin: string;
  email: string;
  unsubscribeLink: string;
}): BuiltEmail {
  const appUrl = `${opts.origin.replace(/\/+$/, '')}/app`;
  const subject = `Welcome to LiveArchive — your archive is ready`;

  const text = [
    `Welcome to LiveArchive! Your account (${opts.email}) is approved and ready.`,
    '',
    `Open your archive: ${appUrl}`,
    '',
    `Recommended next steps:`,
    `1. Add a show you remember: Type one line at the top of Home, like "Porter Robinson at the Greek Theatre, Oct 5 2024" or "EDC Las Vegas 2025".`,
    `2. Scan your ticket emails: On Home, use "Check email in browser" to pull past orders from Ticketmaster, AXS, DICE, Eventbrite, and more. Your emails are read in your browser and nothing is saved until you tick it.`,
    `3. Import a spreadsheet: Have a list in Notion, Excel, or Google Sheets? Download it as CSV and click "Import a list" on Home or in the Table view.`,
    `4. Turn on Private Notes (optional): Open Menu -> Your account to encrypt your notes and companions in your browser with a passphrase only you know.`,
    '',
    '---',
    `Unsubscribe from LiveArchive emails: ${opts.unsubscribeLink}`,
  ].join('\n');

  const html = wrapHtml(
    subject,
    [
      `<h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:22px;margin:0 0 12px;color:#ededf0;">Welcome to LiveArchive</h1>`,
      `<p style="margin:0 0 16px;color:#ededf0;">Your account (<strong>${escapeHtml(opts.email)}</strong>) is approved and your personal concert archive is ready.</p>`,
      `<p style="margin:0 0 24px;"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#a78bfa;color:#0e0e11;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;">Open your archive</a></p>`,
      `<h2 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:17px;margin:0 0 10px;color:#ededf0;">Recommended next steps</h2>`,
      `<ul style="margin:0;padding-left:20px;color:#ededf0;">`,
      `<li style="margin:0 0 10px;"><strong>Add a show in one line:</strong> Type a show at the top of Home, such as <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">Porter Robinson at the Greek Theatre, Oct 5 2024</code> or <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">EDC Las Vegas 2025</code>.</li>`,
      `<li style="margin:0 0 10px;"><strong>Scan your ticket emails:</strong> Use the browser ticket scanner on Home to find past shows from Ticketmaster, AXS, DICE, Eventbrite, and more—your email bodies never leave your browser, and nothing is saved until you tick it.</li>`,
      `<li style="margin:0 0 10px;"><strong>Import a list:</strong> Have an existing spreadsheet or Notion export? Use <em>Import a list</em> on Home or in the Table tab.</li>`,
      `<li style="margin:0;"><strong>Turn on Private Notes (optional):</strong> Open <em>Menu → Your account</em> to encrypt your notes and companions in your browser.</li>`,
      `</ul>`,
    ].join(''),
    opts.unsubscribeLink,
  );

  return { subject, text, html };
}
