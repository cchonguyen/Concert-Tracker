import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardContent, cardEvents, cardFileName, cardText } from '../src/services/shareCard.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

type Partial_ = Partial<LoggedEvent> & { name: string; id: string };

const ev = (p: Partial_): LoggedEvent =>
  ({ seen: [], companions: [], sources: {}, details: { status: 'none', candidates: [] }, input: p.name, ...p }) as unknown as LoggedEvent;

const ALL = { acts: true, exactDates: true, venue: true };

test('a stored headliner goes big, and the supports go small, supports first', () => {
  const e = ev({
    id: 'e1',
    name: 'Night One',
    startDate: '2024-11-02',
    seen: [
      { key: 'a', name: 'Opener', from: 'lineup', role: 'support' },
      { key: 'b', name: 'Star', from: 'lineup', role: 'headliner' },
      { key: 'c', name: 'Plain', from: 'lineup' },
    ],
  });
  const c = cardContent(e, ALL);
  assert.deepEqual(c.big, ['Star']);
  assert.equal(c.eventLine, 'Night One');
  assert.equal(c.small, 'Opener, Plain');
});

test('two stored headliners both go big; no roles and 3 acts puts the event name big', () => {
  const two = ev({
    id: 'e2',
    name: 'Pair',
    seen: [
      { key: 'a', name: 'Left', from: 'lineup', role: 'headliner' },
      { key: 'b', name: 'Right', from: 'lineup', role: 'headliner' },
    ],
  });
  assert.deepEqual(cardContent(two, ALL).big, ['Left', 'Right']);

  const three = ev({
    id: 'e3',
    name: 'Big Night',
    seen: [
      { key: 'a', name: 'One', from: 'lineup' },
      { key: 'b', name: 'Two', from: 'lineup' },
      { key: 'c', name: 'Three', from: 'lineup' },
    ],
  });
  const c = cardContent(three, ALL);
  assert.deepEqual(c.big, ['Big Night']);
  assert.equal(c.eventLine, undefined);
  assert.equal(c.small, 'One, Two, Three');
});

test('acts off: the event name is the only big line, with no small or event line', () => {
  const e = ev({
    id: 'e4',
    name: 'Quiet Show',
    seen: [{ key: 'a', name: 'Star', from: 'lineup', role: 'headliner' }],
  });
  const c = cardContent(e, { acts: false, exactDates: true, venue: true });
  assert.deepEqual(c.big, ['Quiet Show']);
  assert.equal(c.small, undefined);
  assert.equal(c.eventLine, undefined);
});

test('exact dates off hides the short date and the month and day', () => {
  const e = ev({ id: 'e5', name: 'Dated', startDate: '2024-11-02', venue: 'Hall', city: 'Oakland', region: 'CA' });
  const off = cardContent(e, { acts: true, exactDates: false, venue: true });
  assert.equal(off.stub.shortDate, undefined);
  assert.equal(off.when, '2024');
  assert.ok(!JSON.stringify(off).includes('Nov'));

  const on = cardContent(e, ALL);
  assert.deepEqual(on.stub.shortDate, ['11', '02', '24']);
  assert.ok(on.when?.includes('2024'));
  assert.ok(on.when?.includes('Nov'));
});

test('venue off keeps the city and drops the venue', () => {
  const e = ev({ id: 'e6', name: 'Place', startDate: '2024-11-02', venue: 'Warehouse Hall', city: 'Oakland', region: 'CA' });
  const off = cardContent(e, { acts: true, exactDates: true, venue: false });
  assert.ok(off.where?.includes('Oakland'));
  assert.ok(!off.where?.includes('Warehouse Hall'));

  const on = cardContent(e, ALL);
  assert.ok(on.where?.includes('Warehouse Hall'));
  assert.ok(on.where?.includes('Oakland'));
});

test('an event with no city and no venue has no where line', () => {
  const e = ev({ id: 'e7', name: 'Nowhere', year: 2023 });
  const c = cardContent(e, { acts: true, exactDates: false, venue: false });
  assert.equal(c.where, undefined);
  assert.equal(c.when, '2023');
  assert.equal(c.stub.shortDate, undefined);
});

test('private fields never reach the card content', () => {
  const e = ev({
    id: 'e8',
    name: 'Private Night',
    startDate: '2024-11-02',
    venue: 'Hall',
    city: 'Oakland',
    region: 'CA',
    companions: ['Sam Secret'],
    ticketPrice: 287.5,
    rating: 4,
    notes: 'PRIVNOTE',
    seen: [{ key: 'a', name: 'Star', from: 'lineup', role: 'headliner' }],
  } as Partial_);
  const c = cardContent(e, ALL);
  const json = JSON.stringify(c);
  assert.ok(!json.includes('Sam Secret'));
  assert.ok(!json.includes('287.5'));
  assert.ok(!json.includes('PRIVNOTE'));

  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    }
  };
  walk(c);
  for (const forbidden of ['companions', 'with', 'ticketPrice', 'price', 'rating', 'notes', 'order', 'seller', 'ticketCount', 'admit', 'attendance']) {
    assert.ok(!keys.has(forbidden), `key ${forbidden} must not be on the card`);
  }
});

test('the card text summarises the visible lines', () => {
  const e = ev({ id: 'e9', name: 'Summary', startDate: '2024-11-02', seen: [{ key: 'a', name: 'Star', from: 'lineup', role: 'headliner' }] });
  const text = cardText(cardContent(e, ALL));
  assert.ok(text.includes('Star'));
  assert.ok(text.endsWith('Went'));
});

test('cardEvents keeps only the events you went to, newest first', () => {
  const today = '2026-11-25';
  const events = [
    ev({ id: 'old', name: 'Old', startDate: '2024-02-01' }),
    ev({ id: 'new', name: 'New', startDate: '2026-01-10' }),
    ev({ id: 'ahead', name: 'Ahead', startDate: '2026-12-05' }),
    ev({ id: 'missed', name: 'Missed', startDate: '2025-03-03', attendance: 'missed' }),
    ev({ id: 'planned', name: 'Planned', startDate: '2025-04-04', attendance: 'planned' }),
  ];
  assert.deepEqual(
    cardEvents(events, today).map((e) => e.id),
    ['new', 'old'],
  );
});

test('cardFileName slugs the name and adds the date or year', () => {
  assert.equal(
    cardFileName({ name: 'Café Ünïcode Fest!', startDate: '2025-05-16' }),
    'livearchive-cafe-unicode-fest-2025-05-16.png',
  );
  assert.equal(cardFileName({ name: 'Yearly  Show', year: 2024 }), 'livearchive-yearly-show-2024.png');
  assert.equal(cardFileName({ name: '!!!' }), 'livearchive-event.png');
});

test('card search matches name, act, venue, city and year, every word, ignoring case and accents', async () => {
  const { searchCards } = await import('../src/services/shareCard.ts');
  const a = ev({ id: 'a', name: 'Night One', startDate: '2024-11-02', venue: 'The Fillmore', city: 'San Francisco', seen: [{ key: 'x', name: 'Röyksopp', from: 'lineup' }] });
  const b = ev({ id: 'b', name: 'Dreamstate', year: 2023, venue: 'Queen Mary', city: 'Long Beach' });
  const ids = (q: string) => searchCards([a, b], q).map((e) => e.id);
  assert.deepEqual(ids(''), ['a', 'b']);
  assert.deepEqual(ids('  '), ['a', 'b']);
  assert.deepEqual(ids('dream'), ['b']);
  assert.deepEqual(ids('royksopp'), ['a']);
  assert.deepEqual(ids('fillmore'), ['a']);
  assert.deepEqual(ids('long beach'), ['b']);
  assert.deepEqual(ids('2023'), ['b']);
  assert.deepEqual(ids('2024 night'), ['a']);
  assert.deepEqual(ids('2024 dream'), []);
});
