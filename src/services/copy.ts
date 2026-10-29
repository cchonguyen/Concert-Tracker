// The app's written words in one place. Tooltips, notices and the About page read from here,
// so wording changes happen once and match everywhere. Add entries as the screens that use them are built.
export const appName = 'LiveArchive';

// Shown on the About page. Bump it with each release that changes what people see.
export const appVersion = '1.1.0';

// The Home ticket email card. Each privacy claim must match what BrowserScan.tsx and packages/ticket-scanner do.
export const emailCard = {
  eyebrow: 'New: ticket email',
  title: 'Rebuild years of shows from your ticket emails',
  line: 'LiveArchive reads your Gmail for receipts from Ticketmaster, AXS, DICE, Eventbrite, Resident Advisor and 20+ other sellers, and lists every show it finds for you to tick.',
  badges: ['Reads in your browser', 'Read-only access', 'Nothing added until you tick it'],
  steps: [
    'Sign in with Google. Google asks you to let LiveArchive read your Gmail. It can’t send, delete or change anything. The permission lasts about an hour and is cancelled the moment the check ends.',
    'Your browser does the reading. The check runs on this page, on your device. Your emails are opened and read here, not on our server.',
    'You pick what counts. Each show it finds lands on a review list, unticked. A ticket isn’t proof you went, so nothing joins your history until you tick it, or match it to a show you already entered.',
  ],
  warning:
    'Google will show a warning. That’s expected. LiveArchive is a small personal project, so it hasn’t been through Google’s paid app review. You’ll see “Google hasn’t verified this app”. Tap Advanced, then Go to LiveArchive. The access is still read-only and still ends when the check does. Prefer not to connect Gmail? You can also import a CSV spreadsheet or add shows by hand.',
  savedHere: [
    'For each show found: name, date, venue, city, seller, order number, ticket count and total',
    'The one line from the email each detail was read from, so you can check it',
    'A link back to the email in Gmail, plus its subject, sender and date',
    'Any email that isn’t a ticket receipt (only its subject is kept if it looked like one but couldn’t be read)',
  ],
  neverLeaves: ['The body of any email', 'Your Google sign-in or its access'],
  smallPrint: [
    'The first check reads everything back to your earliest ticket email. That can take a few minutes for a big inbox; you can keep using the app.',
    'After that, Check my email reads only mail that arrived since last time.',
    'Refunds, cancellations and tickets you sent to someone else are flagged, so you don’t count a show you skipped.',
    'Some older emails can’t be read. They’re listed with a link so you can add those shows yourself.',
  ],
} as const;

// One callout per page, shown under the page heading until dismissed. The wording comes from the proposal's callout table.
export const callouts: Partial<Record<'summary' | 'table' | 'manage', string>> = {
  summary: 'Your shows, newest first. Tap one to add who you saw, who you went with, and your notes.',
  table: 'Sort, filter and search everything. Fill gaps finds shows missing a date, city or lineup and fixes them in one pass.',
  manage: 'Fix spellings across every show at once. Merge two artists, venues or people into one, and undo any change from History.',
};

export const copy = {
  appName,
  appVersion,
  emailCard,
  callouts,
} as const;
