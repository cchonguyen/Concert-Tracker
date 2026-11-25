import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitCount,
  barcodeBars,
  shortDate,
  shorthand,
  showNumber,
  stubPieces,
  stubPiecesShared,
  stubSentence,
  ticketLines,
} from '../src/services/ticket.ts';

test('one stored headliner goes big and the supports go small, supports first', () => {
  const r = ticketLines('Night One', [
    { name: 'Opener Act', role: 'support' },
    { name: 'Star' , role: 'headliner' },
    { name: 'Plain' },
    { name: 'Second Support', role: 'support' },
  ]);
  assert.deepEqual(r.big, ['Star']);
  assert.equal(r.bigIsEvent, false);
  assert.equal(r.moreHeadliners, 0);
  assert.deepEqual(r.small, ['Opener Act', 'Second Support', 'Plain']);
  assert.equal(r.askWhoSaw, false);
});

test('two stored headliners go big joined by the event line rule', () => {
  const r = ticketLines('Summer Tour', [
    { name: 'Alpha', role: 'headliner' },
    { name: 'Beta', role: 'headliner' },
  ]);
  assert.deepEqual(r.big, ['Alpha', 'Beta']);
  assert.equal(r.bigIsEvent, false);
  assert.equal(r.showEventLine, true);
  assert.deepEqual(r.small, []);
});

test('an inferred headliner counts as a headliner', () => {
  const r = ticketLines('Solo Night', [
    { name: 'Solo Name', role: 'headliner', inferred: true },
    { name: 'Guest', role: 'support', inferred: true },
  ]);
  assert.deepEqual(r.big, ['Solo Name']);
  assert.deepEqual(r.small, ['Guest']);
  assert.equal(r.bigIsEvent, false);
});

test('four headliners: first two go big, the other two are counted and kept out of small', () => {
  const r = ticketLines('Mega Fest', [
    { name: 'H1', role: 'headliner' },
    { name: 'H2', role: 'headliner' },
    { name: 'H3', role: 'headliner' },
    { name: 'H4', role: 'headliner' },
    { name: 'S1', role: 'support' },
  ]);
  assert.deepEqual(r.big, ['H1', 'H2']);
  assert.equal(r.moreHeadliners, 2);
  assert.deepEqual(r.small, ['S1']);
});

test('three acts with no roles put the event name big and every act small', () => {
  const r = ticketLines('Warehouse Party', [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  assert.deepEqual(r.big, ['Warehouse Party']);
  assert.equal(r.bigIsEvent, true);
  assert.equal(r.showEventLine, false);
  assert.deepEqual(r.small, ['A', 'B', 'C']);
  assert.equal(r.moreHeadliners, 0);
});

test('two acts with no roles both go big', () => {
  const r = ticketLines('Club Night', [{ name: 'A' }, { name: 'B' }]);
  assert.deepEqual(r.big, ['A', 'B']);
  assert.equal(r.bigIsEvent, false);
  assert.equal(r.showEventLine, true);
  assert.deepEqual(r.small, []);
});

test('one act with no roles goes big', () => {
  const r = ticketLines('Club Night', [{ name: 'Only One' }]);
  assert.deepEqual(r.big, ['Only One']);
  assert.equal(r.bigIsEvent, false);
  assert.equal(r.showEventLine, true);
});

test('roles present but no headliner put the event name big', () => {
  const r = ticketLines('Fest', [{ name: 'Sup', role: 'support' }, { name: 'Other' }]);
  assert.equal(r.bigIsEvent, true);
  assert.deepEqual(r.big, ['Fest']);
  assert.deepEqual(r.small, ['Sup', 'Other']);
});

test('a list order never makes a headliner', () => {
  const r = ticketLines('Fest', [{ name: 'First' }, { name: 'Second' }, { name: 'Third' }]);
  assert.equal(r.bigIsEvent, true);
  assert.deepEqual(r.big, ['Fest']);
});

test('event name equal to the act name drops the event line', () => {
  const r = ticketLines('  boiler  room!! ', [{ name: 'Boiler Room', role: 'headliner' }]);
  assert.equal(r.showEventLine, false);
  const other = ticketLines('Boiler Room Night', [{ name: 'Boiler Room', role: 'headliner' }]);
  assert.equal(other.showEventLine, true);
});

test('event name equal to two headliners joined with & drops the event line', () => {
  const r = ticketLines('Dom Dolla and John Summit', [
    { name: 'Dom Dolla', role: 'headliner' },
    { name: 'John Summit', role: 'headliner' },
  ]);
  assert.equal(r.showEventLine, true);
  const same = ticketLines('Dom Dolla & John Summit', [
    { name: 'Dom Dolla', role: 'headliner' },
    { name: 'John Summit', role: 'headliner' },
  ]);
  assert.equal(same.showEventLine, false);
});

test('no acts asks who you saw and puts the event name big', () => {
  const r = ticketLines('Empty Night', []);
  assert.deepEqual(r.big, ['Empty Night']);
  assert.equal(r.bigIsEvent, true);
  assert.equal(r.askWhoSaw, true);
  assert.deepEqual(r.small, []);
});

test('admitCount is 1 plus the non-blank companion names', () => {
  assert.equal(admitCount([]), 1);
  assert.equal(admitCount(['Ann', '  ', '', ' Bo ']), 3);
  assert.equal(admitCount(['', '   ']), 1);
});

test('shortDate boxes a full date as MM, DD, YY', () => {
  assert.deepEqual(shortDate({ startDate: '2026-10-31' }), ['10', '31', '26']);
});

test('shortDate boxes a month only as MON and YY', () => {
  assert.deepEqual(shortDate({ year: 2024, month: 9 }), ['SEP', '24']);
  assert.deepEqual(shortDate({ year: 2026, month: 1 }), ['JAN', '26']);
});

test('shortDate is null for a year only, a missing date, or an invalid month', () => {
  assert.equal(shortDate({ year: 2024 }), null);
  assert.equal(shortDate({}), null);
  assert.equal(shortDate({ month: 3 }), null);
  assert.equal(shortDate({ year: 2024, month: 13 }), null);
});

test('shorthand is deterministic, short, and only A-Z0-9', () => {
  const a = shorthand('Velvet Orchards');
  assert.equal(a, shorthand('Velvet Orchards'));
  assert.equal(a, 'VLVTOR');
  assert.ok(a.length <= 6);
  assert.match(a, /^[A-Z0-9]+$/);
  for (const text of ['Tiësto', 'Sigur Rós!!', 'a-b c', 'Mau P 2026']) {
    const s = shorthand(text, 8);
    assert.ok(s.length <= 8);
    assert.match(s, /^[A-Z0-9]*$/);
  }
});

test('shorthand falls back to the first letters when the rule gives under 3 characters', () => {
  assert.equal(shorthand('Ab'), 'AB');
  assert.equal(shorthand('A I'), 'AI');
});

test('barcodeBars is deterministic, sized, and in 1 to 4', () => {
  const bars = barcodeBars('event-123');
  assert.deepEqual(barcodeBars('event-123'), bars);
  assert.equal(bars.length, 36);
  assert.equal(barcodeBars('x', 10).length, 10);
  for (const b of bars) {
    assert.ok(Number.isInteger(b) && b >= 1 && b <= 4);
  }
});

test('barcodeBars differs between two sample seeds', () => {
  assert.notDeepEqual(barcodeBars('event-123'), barcodeBars('event-124'));
  assert.notDeepEqual(barcodeBars('alpha'), barcodeBars('beta'));
});

test('showNumber counts only went-to events, oldest first', () => {
  const events = [
    { id: 'c', startDate: '2026-03-01' },
    { id: 'missed', startDate: '2025-06-01', attendance: 'missed' as const },
    { id: 'future', startDate: '2026-12-01' },
    { id: 'a', startDate: '2024-05-10' },
    { id: 'b', year: 2025, month: 2 },
    { id: 'undated', attendance: undefined as undefined },
  ];
  const today = '2026-11-25';
  assert.equal(showNumber('a', events, today), 1);
  assert.equal(showNumber('b', events, today), 2);
  assert.equal(showNumber('c', events, today), 3);
  assert.equal(showNumber('missed', events, today), null);
  assert.equal(showNumber('future', events, today), null);
  assert.equal(showNumber('undated', events, today), null);
  assert.equal(showNumber('nope', events, today), null);
});

test('showNumber ignores a missed event when numbering later ones', () => {
  const events = [
    { id: 'x', startDate: '2024-01-01', attendance: 'missed' as const },
    { id: 'y', startDate: '2024-02-01' },
  ];
  assert.equal(showNumber('y', events, '2026-01-01'), 1);
});

test('stubPieces drops missing facts and respects a small room', () => {
  const none = { shortDate: false, ticketFacts: false, went: false, showNumber: false };
  assert.deepEqual(stubPieces(none, 10), ['admit', 'barcode', 'shorthand']);
  assert.deepEqual(stubPieces({ ...none, shortDate: true, ticketFacts: true }, 10), [
    'admit',
    'shortDate',
    'barcode',
    'ticketFacts',
    'shorthand',
  ]);
  const full = { shortDate: true, ticketFacts: true, went: true, showNumber: true };
  assert.deepEqual(stubPieces(full, 10), [
    'admit',
    'shortDate',
    'barcode',
    'ticketFacts',
    'went',
    'showNumber',
    'shorthand',
  ]);
  assert.deepEqual(stubPieces(full, 2), ['admit', 'shortDate']);
  assert.deepEqual(stubPieces(full, 0), []);
  // showNumber and shorthand wait until everything before them fits
  assert.deepEqual(stubPieces(full, 5), ['admit', 'shortDate', 'barcode', 'ticketFacts', 'went']);
  assert.deepEqual(stubPieces(full, 6), ['admit', 'shortDate', 'barcode', 'ticketFacts', 'went', 'showNumber']);
});

test('stubPiecesShared never includes admit or ticketFacts', () => {
  const all = stubPiecesShared({ shortDate: true, went: true }, 10);
  assert.deepEqual(all, ['went', 'shorthand', 'barcode', 'shortDate']);
  assert.deepEqual(stubPiecesShared({ shortDate: false, went: false }, 10), ['shorthand', 'barcode']);
  assert.deepEqual(stubPiecesShared({ shortDate: true, went: true }, 2), ['went', 'shorthand']);
  for (const p of stubPiecesShared({ shortDate: true, went: true }, 10)) {
    assert.notEqual(p, 'admit');
    assert.notEqual(p, 'ticketFacts');
  }
});

test('stubSentence formats admit, price and went', () => {
  assert.equal(
    stubSentence({ admit: 3, price: 189, went: '2 November 2026' }),
    'Admit 3, $189, went 2 November 2026.',
  );
  assert.equal(stubSentence({ admit: 1, price: 189.5 }), 'Admit 1, $189.50.');
  assert.equal(stubSentence({ admit: 2 }), 'Admit 2.');
  assert.equal(stubSentence({ admit: 2, went: '  ' }), 'Admit 2.');
  assert.equal(stubSentence({ admit: 1, price: 1189 }), 'Admit 1, $1,189.');
});
