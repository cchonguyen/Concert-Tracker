import assert from 'node:assert/strict';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import type { EventWeather, LoggedEvent } from '../src/server/events/types.ts';
import { resolveEvent } from '../src/server/events/inherit.ts';

const captured: EventWeather = {
  place: 'Las Vegas, NV',
  latitude: 36.17,
  longitude: -115.14,
  days: [{ date: '2025-05-16', high: 30, low: 20, precipitation: 0, code: 0 }],
  sourceUrl: 'https://archive-api.open-meteo.com/v1/archive?latitude=36.17',
  checkedAt: '2026-01-01T00:00:00.000Z',
};
const shared: EventWeather = {
  ...captured,
  days: [{ date: '2025-05-16', high: 31.2, low: 21.9, precipitation: 0, code: 0 }],
  checkedAt: '2026-11-18T00:00:00.000Z',
};

const edition = (weather?: EventWeather): Edition => ({
  id: 'ed-1',
  key: 'fest-2025',
  year: 2025,
  name: 'Fest 2025',
  status: 'verified',
  updatedAt: '2026-11-18T00:00:00.000Z',
  performances: [],
  ...(weather ? { weather } : {}),
});

const event = { id: 'ev-1', editionId: 'ed-1', city: 'Las Vegas, NV', startDate: '2025-05-16', endDate: '2025-05-16', sources: {}, weather: captured } as unknown as LoggedEvent;

test('a linked event shows the edition weather record over its own copy', () => {
  assert.deepEqual(resolveEvent(event, edition(shared)).weather, shared);
});

test('a linked event with no edition record keeps its own copy as the fallback', () => {
  assert.deepEqual(resolveEvent(event, edition()).weather, captured);
});
