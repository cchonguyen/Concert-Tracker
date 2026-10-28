import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanEmails } from '../src/scan.ts';
import { emailLines, decodeEntities } from '../src/text.ts';
import { unzipEntry } from '../src/markup.ts';
import { normalize } from '../src/verbatim.ts';
import type { EmailImportProposal, RawEmailMessage } from '../src/types.ts';
import { buildCorpus, type Fixture } from './fixtures/corpus.ts';

// The PRD's release gate over the 100-message synthetic corpus
// (tests/fixtures/corpus.ts). It guards the readers' invariants and catches
// regressions; it does not measure recall on a real inbox.

const corpus = buildCorpus();
const shows = corpus.filter((f) => f.expect);
const traps = corpus.filter((f) => !f.expect);
const results = new Map<Fixture, EmailImportProposal[]>();
for (const f of corpus) results.set(f, await scanEmails([f.email]));

function structured(f: Fixture): string | null {
  const e = f.expect!;
  const p = results.get(f)!.find((x) => x.status === 'new');
  if (!p) return 'no proposal';
  const diffs: string[] = [];
  if (p.name?.value !== e.name) diffs.push(`name ${p.name?.value}`);
  if (p.date?.value !== e.date) diffs.push(`date ${p.date?.value}`);
  if (e.venue && p.venue?.value !== e.venue) diffs.push(`venue ${p.venue?.value}`);
  if (e.city && p.city?.value !== e.city) diffs.push(`city ${p.city?.value}`);
  if (e.price === null && p.ticketPrice) diffs.push(`price claimed ${p.ticketPrice.amount}`);
  if (typeof e.price === 'number' && p.ticketPrice?.amount !== e.price) diffs.push(`price ${p.ticketPrice?.amount}`);
  return diffs.length ? diffs.join(', ') : null;
}

test('corpus: the distribution is 50 / 20 / 15 / 10 / 5', () => {
  const by = (g: string) => corpus.filter((f) => f.group === g).length;
  assert.deepEqual([by('tier1'), by('boutique'), by('forwarded'), by('longtail'), by('trap')], [50, 20, 15, 10, 5]);
});

test('corpus: exact structured extraction on show mail is at least 92%', () => {
  const misses = shows.flatMap((f) => {
    const why = structured(f);
    return why ? [`${f.label}: ${why}`] : [];
  });
  const rate = (shows.length - misses.length) / shows.length;
  if (misses.length) console.log(`structured misses (${misses.length}):\n  ${misses.join('\n  ')}`);
  assert.ok(rate >= 0.92, `structured ${(rate * 100).toFixed(1)}%`);
});

test('corpus: at least 98% of show mail surfaces, structured or as unreadable with its link', () => {
  const lost = shows.filter((f) => !results.get(f)!.some((p) => (p.status === 'new' || p.status === 'unreadable') && p.messageLinks.includes(f.email.link)));
  const rate = (shows.length - lost.length) / shows.length;
  assert.ok(rate >= 0.98, `surfaced ${(rate * 100).toFixed(1)}%, lost: ${lost.map((f) => f.label).join(', ')}`);
});

test('corpus: no trap produces anything', () => {
  for (const f of traps) assert.deepEqual(results.get(f), [], `${f.label} surfaced`);
});

async function sourceOf(e: RawEmailMessage): Promise<string> {
  const parts = [...emailLines(e), e.subject, decodeEntities(e.html ?? '')];
  for (const a of e.attachments ?? []) {
    const bytes = Uint8Array.from(Buffer.from(a.dataBase64, 'base64'));
    if (a.filename.endsWith('.pkpass')) parts.push(new TextDecoder().decode((await unzipEntry(bytes, 'pass.json')) ?? new Uint8Array()));
    else parts.push(new TextDecoder().decode(bytes).replace(/\\,/g, ','));
  }
  return normalize(parts.join('\n'));
}

test('corpus: every extracted field quotes its message verbatim', async () => {
  let checked = 0;
  for (const f of corpus) {
    const source = await sourceOf(f.email);
    for (const p of results.get(f)!) {
      for (const field of [p.name, p.date, p.endDate, p.venue, p.city]) {
        if (!field) continue;
        checked++;
        assert.ok(source.includes(normalize(field.quote)), `${f.label}: quote not in message: ${field.quote}`);
        if (field === p.name || field === p.venue) assert.ok(normalize(field.quote).includes(normalize(field.value)), `${f.label}: value not in quote: ${field.value}`);
      }
    }
  }
  assert.ok(checked > 200);
});

test('corpus: a show nobody can read is surfaced as unreadable with its link', async () => {
  const email = { ...shows[0].email, id: 'broken', link: 'https://mail.google.com/mail/u/0/#all/broken', html: undefined, text: 'Your tickets are ready' };
  const [p] = await scanEmails([email]);
  assert.equal(p.status, 'unreadable');
  assert.deepEqual(p.messageLinks, [email.link]);
  assert.equal(p.rawSubject, email.subject);
});

test('corpus: two emails about one order make one proposal with the per-ticket price', async () => {
  const tixr = shows.find((f) => f.label.startsWith('Tixr'))!;
  const proposals = await scanEmails([tixr.email, { ...tixr.email, id: 'again', link: `${tixr.email.link}-again` }]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].ticketPrice?.amount, tixr.expect!.price);
  assert.equal(proposals[0].messageLinks.length, 2);
});
