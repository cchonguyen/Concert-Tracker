import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmailImportProposal } from '@livearchive/ticket-scanner';
import { mergeProposals } from '../src/server/events/email/proposals';
import type { EmailImport } from '../src/server/events/email/types';

const now = new Date('2026-10-28T12:00:00Z');
const link = (id: string) => `https://mail.google.com/mail/u/0/#all/${id}`;
const ev = (value: string, id = 'm1') => ({ value, quote: value, messageId: id, messageLink: link(id), readBy: 'layout' as const });

const proposal = (over: Partial<EmailImportProposal> = {}): EmailImportProposal => ({
  key: 'k',
  status: 'new',
  seller: 'Ticketmaster',
  name: ev('Bonobo'),
  date: ev('2024-05-03'),
  venue: ev('The Greek'),
  flags: [],
  messageLinks: [link('m1')],
  ...over,
});
const scanned = [{ id: 'm1', link: link('m1'), from: 'x@ticketmaster.com', subject: 'Your tickets', sentAt: '2024-04-01T00:00:00.000Z', stream: 'A' as const }];

test('proposals: a new show becomes a review row with its quotes', () => {
  const [row] = mergeProposals([], [proposal()], scanned, [], now);
  assert.equal(row.status, 'new');
  assert.equal(row.key, 'bonobo|2024-05-03');
  assert.equal(row.venue, 'The Greek');
  assert.equal(row.sources.venue?.quote, 'The Greek');
  assert.equal(row.messages[0].subject, 'Your tickets');
});

test('proposals: an existing row keeps its values and your choice; only empty fields fill', () => {
  const existing: EmailImport = {
    id: 'r1', key: 'bonobo|2024-05-03', status: 'skipped', seller: 'Ticketmaster', name: 'Bonobo', startDate: '2024-05-03',
    venue: 'Greek Theatre', sources: {}, messages: [{ id: 'm1', subject: 's', sentAt: '2024-04-01T00:00:00.000Z' }], flags: [],
    createdAt: '', updatedAt: '',
  };
  const [row] = mergeProposals([existing], [proposal({ city: ev('Berkeley') })], scanned, [], now);
  assert.equal(row.status, 'skipped');
  assert.equal(row.venue, 'Greek Theatre');
  assert.equal(row.city, 'Berkeley');
});

test('proposals: a re-scan of the same mail changes nothing', () => {
  const first = mergeProposals([], [proposal()], scanned, [], now);
  assert.deepEqual(mergeProposals(first, [proposal()], scanned, [], now), []);
});

test('proposals: unreadable rows keep the subject; flags map to the host names', () => {
  const rows = mergeProposals([], [
    proposal({ status: 'unreadable', name: undefined, rawSubject: 'Order 123', messageLinks: [link('m9')] }),
    proposal({ flags: [{ kind: 'transferred', quote: 'sent', messageLink: link('m1'), sentAt: '' }] }),
  ], scanned, [], now);
  assert.equal(rows.find((r) => r.status === 'unreadable')?.name, 'Order 123');
  assert.deepEqual(rows.find((r) => r.status === 'new')?.flags, ['transferred_away']);
});
