import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leavesGap, researchEvent, type DetailFinder } from '../src/server/events/details.ts';
import { newEvent } from '../src/server/events/service.ts';
import type { DetailCandidate } from '../src/server/events/types.ts';
import { fakeFetcher } from './fakes.ts';

// Stage 3.3: web search (Brave, id 'discovered') runs only when the free finders leave a gap.
const NOW = new Date('2026-11-18T12:00:00Z');
const fetcher = fakeFetcher({}).fetcher;

const finder = (id: DetailFinder['id'], cands: DetailCandidate[], calls: string[]): DetailFinder => ({
  id,
  enabled: () => true,
  withoutYear: true,
  find: async () => {
    calls.push(id);
    return cands;
  },
});

const cand = (sourceType: DetailCandidate['sources'][number]['sourceType'], over: Partial<DetailCandidate> = {}): DetailCandidate => ({
  id: `c-${sourceType}`,
  name: 'Test Fest',
  startDate: '2024-10-05',
  venue: 'Greek Theatre',
  city: 'Los Angeles',
  sources: [{ sourceType, sourceUrl: `https://x.example/${sourceType}`, fields: ['startDate', 'venue', 'city'] }],
  ...over,
});

test('leavesGap: without a full date, a gap is no candidate with a date; with one, an empty venue or city unanswered', () => {
  const undated = { ...newEvent('Test Fest 2024', NOW), startDate: undefined };
  assert.equal(leavesGap(undated, []), true);
  assert.equal(leavesGap(undated, [cand('ticketmaster')]), false);
  const dated = { ...newEvent('Test Fest Oct 5 2024', NOW), startDate: '2024-10-05', venue: 'Greek Theatre', city: 'Los Angeles' };
  assert.equal(leavesGap(dated, []), false, 'venue and city typed: nothing to look for');
  const noVenue = { ...dated, venue: undefined };
  assert.equal(leavesGap(noVenue, []), true);
  assert.equal(leavesGap(noVenue, [cand('ticketmaster')]), false);
});

test('Brave is not called when a free finder answers the gaps', async () => {
  const calls: string[] = [];
  const ev = { ...newEvent('Test Fest Oct 5 2024', NOW), startDate: '2024-10-05' };
  const out = await researchEvent(ev, [finder('ticketmaster', [cand('ticketmaster')], calls), finder('discovered', [cand('discovered')], calls)], fetcher, NOW);
  assert.deepEqual(calls, ['ticketmaster']);
  assert.ok(out.details.notes.some((n) => n.startsWith('discovered: not searched')));
});

test('Brave is called when the free finders leave a gap', async () => {
  const calls: string[] = [];
  const ev = newEvent('Test Fest 2024', NOW);
  await researchEvent(ev, [finder('ticketmaster', [], calls), finder('discovered', [cand('discovered')], calls)], fetcher, NOW);
  assert.deepEqual(calls, ['ticketmaster', 'discovered']);
});
