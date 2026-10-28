import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRawEmails } from '../src/scan.ts';
import { emailLines } from '../src/text.ts';
import { CONCERTS, TRAPS } from './corpus/fixtures.ts';

// The CI gate from the PRD, run over the fixtures in tests/corpus/fixtures.ts:
// recall on show mail, no show from non-show mail, and every quote verbatim.

function found(f: (typeof CONCERTS)[number]) {
  return readRawEmails([f.email]).find((p) => p.status === 'new' && p.name?.value && p.date);
}

test('corpus: structured recall on show mail is at least 92%', () => {
  const misses: string[] = [];
  for (const f of CONCERTS) {
    const p = found(f);
    const ok =
      p &&
      p.name!.value === f.expect!.name &&
      p.date!.value === f.expect!.date &&
      (!f.expect!.venue || p.venue?.value === f.expect!.venue) &&
      (!f.expect!.city || p.city?.value === f.expect!.city);
    if (!ok) misses.push(f.label);
  }
  const recall = (CONCERTS.length - misses.length) / CONCERTS.length;
  assert.ok(recall >= 0.92, `recall ${recall}, missed: ${misses.join(', ')}`);
});

test('corpus: non-show mail never becomes a show', () => {
  for (const f of TRAPS) {
    const shows = readRawEmails([f.email]).filter((p) => p.status === 'new');
    assert.equal(shows.length, 0, `${f.label} produced a show`);
  }
});

test('corpus: every quote is a substring of its message', () => {
  for (const f of [...CONCERTS, ...TRAPS]) {
    const source = [...emailLines(f.email), f.email.subject].join('\n').replace(/\s+/g, ' ').toLowerCase();
    for (const p of readRawEmails([f.email])) {
      for (const field of [p.name, p.date, p.endDate, p.venue, p.city]) {
        if (!field) continue;
        const q = field.quote.replace(/\s+/g, ' ').toLowerCase();
        assert.ok(source.includes(q), `${f.label}: quote not in message: ${field.quote}`);
      }
    }
  }
});

test('corpus: a show nobody can read is surfaced as unreadable with its link', () => {
  const email = CONCERTS[0].email;
  const broken = { ...email, id: 'broken', html: undefined, text: 'Your tickets are ready', subject: 'You Got Tickets To Porter Robinson' };
  const [p] = readRawEmails([broken]);
  assert.equal(p.status, 'unreadable');
  assert.deepEqual(p.messageLinks, [broken.link]);
  assert.equal(p.rawSubject, broken.subject);
});

test('corpus: two emails about one order make one proposal with the per-ticket price', () => {
  const tixr = CONCERTS.find((f) => f.label === 'Tixr')!.email;
  const proposals = readRawEmails([tixr, { ...tixr, id: 'again' }]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].ticketPrice?.amount, 44);
});
