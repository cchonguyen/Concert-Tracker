import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyLinkedPatch, capturedFrom, ensureCaptured, recordOverrides, resolveEvent, unlinkEvent } from '../src/server/events/inherit.ts';
import { newEvent, newEventFromEdition } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const NOW = new Date('2026-11-11T12:00:00Z');
const LATER = new Date('2026-11-12T12:00:00Z');

const edition = (extra: Partial<Edition> = {}): Edition => ({
  id: 'ed1', key: 'porter/2024', seriesSlug: 'porter', year: 2024, name: 'Porter Robinson',
  startDate: '2024-10-05', endDate: '2024-10-06', venue: 'The Greek Theatre', city: 'Los Angeles', country: 'United States',
  status: 'confirmed', performances: [], updatedAt: NOW.toISOString(), ...extra,
});

// Typed first, then linked: captured holds what was typed.
const linkedEvent = () => {
  const typed = ensureCaptured(newEvent('Porter at the Greek, Oct 5 2024', NOW));
  return { ...typed, editionId: 'ed1' };
};

test('captured is written once and never replaced', () => {
  const a = ensureCaptured(newEvent('Porter Robinson at the Greek, Oct 5 2024', NOW));
  assert.equal(a.captured?.start_date, '2024-10-05');
  const b = ensureCaptured({ ...a, name: 'Changed' });
  assert.equal(b.captured?.name, a.captured?.name);
  const { event } = applyLinkedPatch(a, null, { name: 'Renamed' }, LATER);
  assert.equal(event.captured?.name, a.captured?.name);
  assert.equal(event.name, 'Renamed');
});

test('a linked event shows the edition value; the typed text stays in captured', () => {
  const ev = linkedEvent();
  const shown = resolveEvent(ev, edition());
  assert.equal(shown.name, 'Porter Robinson');
  assert.equal(shown.venue, 'The Greek Theatre');
  assert.equal(shown.endDate, '2024-10-06');
  assert.equal(shown.captured?.name, ev.captured?.name);
  assert.equal(ev.name, newEvent('Porter at the Greek, Oct 5 2024', NOW).name);
});

test('an edition with no value for a field leaves the event\'s own value', () => {
  const ev = { ...linkedEvent(), venue: 'My Venue' };
  assert.equal(resolveEvent(ev, edition({ venue: undefined })).venue, 'My Venue');
});

test('without the edition loaded or without a link, nothing is overlaid', () => {
  const ev = linkedEvent();
  assert.equal(resolveEvent(ev, null), ev);
  const plain = ensureCaptured(newEvent('Zedd', NOW));
  assert.equal(resolveEvent(plain, edition()), plain);
});

test('editing a linked field writes an override and one review change', () => {
  const ev = linkedEvent();
  const { event, changes } = applyLinkedPatch(ev, edition(), { venue: 'Hollywood Bowl' }, LATER);
  assert.deepEqual(event.overrides, { venue: 'Hollywood Bowl' });
  assert.deepEqual(changes, [{ field: 'venue', old: 'The Greek Theatre', new: 'Hollywood Bowl' }]);
  assert.equal(resolveEvent(event, edition()).venue, 'Hollywood Bowl');
  assert.equal(resolveEvent(event, edition()).city, 'Los Angeles');
});

test('an edition change reaches the event except overridden fields', () => {
  const { event } = applyLinkedPatch(linkedEvent(), edition(), { venue: 'Hollywood Bowl' }, LATER);
  const shown = resolveEvent(event, edition({ venue: 'New Name', city: 'Pasadena' }));
  assert.equal(shown.venue, 'Hollywood Bowl');
  assert.equal(shown.city, 'Pasadena');
});

test('setting a field back to the edition value drops the override and adds no review row', () => {
  const first = applyLinkedPatch(linkedEvent(), edition(), { venue: 'Hollywood Bowl' }, LATER);
  const back = applyLinkedPatch(first.event, edition(), { venue: 'The Greek Theatre' }, LATER);
  assert.deepEqual(back.event.overrides, {});
  assert.deepEqual(back.changes, []);
});

test('a patch that changes nothing, or personal fields only, writes no override', () => {
  const { event, changes } = applyLinkedPatch(linkedEvent(), edition(), { rating: 5, notes: 'great', companions: ['Sam'] }, LATER);
  assert.deepEqual(event.overrides, {});
  assert.deepEqual(changes, []);
  assert.equal(event.rating, 5);
});

test('clearing a linked field is an override to blank, not a refill', () => {
  const { event, changes } = applyLinkedPatch(linkedEvent(), edition(), { endDate: null }, LATER);
  assert.deepEqual(event.overrides, { end_date: null });
  assert.equal(resolveEvent(event, edition()).endDate, undefined);
  assert.deepEqual(changes, [{ field: 'endDate', old: '2024-10-06', new: null }]);
});

test('unlinking falls back to the override, else what was first typed', () => {
  const ev = linkedEvent();
  const { event } = applyLinkedPatch(ev, edition(), { venue: 'Hollywood Bowl' }, LATER);
  const un = unlinkEvent(event, LATER);
  assert.equal(un.editionId, undefined);
  assert.equal(un.venue, 'Hollywood Bowl');
  assert.equal(un.name, ev.captured?.name);
  assert.equal(un.startDate, '2024-10-05');
  assert.equal(un.city, undefined); // typed line had no city: stays missing, not the edition's
  assert.deepEqual(un.overrides, {});
  assert.deepEqual(un.captured, ev.captured);
});

test('an unlinked event edits its own values and keeps captured', () => {
  const ev = ensureCaptured(newEvent('Zedd, Oct 5 2024', NOW));
  const { event, changes } = applyLinkedPatch(ev, null, { venue: 'Red Rocks' }, LATER);
  assert.equal(event.venue, 'Red Rocks');
  assert.equal(event.captured?.venue, null);
  assert.deepEqual(changes, []);
});

test('list import: an unedited new event takes the import as captured, once', () => {
  const created = ensureCaptured(newEvent('Row name', NOW));
  const first = applyLinkedPatch(created, null, { name: 'Row name', startDate: '2023-05-05', venue: 'The Fillmore' }, LATER, { recapture: true });
  assert.equal(first.event.captured?.venue, 'The Fillmore');
  assert.equal(first.event.captured?.start_date, '2023-05-05');
  const second = applyLinkedPatch(first.event, null, { venue: 'Elsewhere' }, new Date('2026-11-13T00:00:00Z'), { recapture: true });
  assert.equal(second.event.captured?.venue, 'The Fillmore');
  assert.equal(second.event.venue, 'Elsewhere');
});

test('list import on a linked event writes overrides, not the edition value', () => {
  const ev = linkedEvent();
  const { event } = applyLinkedPatch(ev, edition(), { name: 'Porter (imported)', startDate: '2024-10-05' }, LATER, { recapture: true });
  assert.deepEqual(event.overrides, { name: 'Porter (imported)' });
  assert.deepEqual(event.captured, ev.captured);
});

test('from an edition: the shown value and captured stay apart', () => {
  const ev = ensureCaptured(newEventFromEdition('Porter at the Greek', edition(), NOW));
  assert.equal(ev.captured?.venue, 'The Greek Theatre');
  assert.deepEqual(capturedFrom(ev).country, 'United States');
});

test('review rows hold only ids, field and public values; the store refuses personal fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'inherit-'));
  try {
    const store = new FileLineupStore(path.join(dir, 'store.json'));
    const ev = { ...linkedEvent(), rating: 5, notes: 'secret', companions: ['Sam'] };
    const { event, changes } = applyLinkedPatch(ev, edition(), { venue: 'Hollywood Bowl' }, LATER);
    const rows = await recordOverrides(store, event, changes);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'override');
    assert.equal(rows[0].editionId, 'ed1');
    assert.equal(rows[0].eventId, event.id);
    assert.deepEqual(rows[0].payload, { field: 'venue', old: 'The Greek Theatre', new: 'Hollywood Bowl' });
    assert.ok(!/secret|Sam|rating|notes/.test(JSON.stringify(rows[0])));
    assert.equal((await store.listReviewItems({ kind: 'override' })).length, 1);
    // captured and overrides survive the store.
    await store.putEvent(event);
    const back = await store.getEvent(event.id);
    assert.deepEqual(back?.overrides, { venue: 'Hollywood Bowl' });
    assert.deepEqual(back?.captured, ev.captured);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
