import assert from 'node:assert/strict';
import { test } from 'node:test';
import { haversineMiles, metroRadiusMiles, withinRadius } from '../src/server/events/place.ts';

const LA = { lat: 34.0522, lon: -118.2437 };
const INGLEWOOD = { lat: 33.9617, lon: -118.3531 };
const SAN_DIEGO = { lat: 32.7157, lon: -117.1611 };
const NEW_YORK = { lat: 40.7128, lon: -74.006 };

test('haversine: zero for the same point, and about 15 miles from Los Angeles to Inglewood', () => {
  assert.equal(haversineMiles(LA, LA), 0);
  const d = haversineMiles(LA, INGLEWOOD);
  assert.ok(d > 8 && d < 11, `expected about 9 miles, got ${d}`);
});

test('haversine: Los Angeles to San Diego is about 110 miles and to New York about 2,450', () => {
  assert.ok(Math.abs(haversineMiles(LA, SAN_DIEGO) - 109) < 4);
  assert.ok(Math.abs(haversineMiles(LA, NEW_YORK) - 2445) < 20);
});

test('withinRadius: keeps a suburb and drops a distant city at the default 50 miles', () => {
  assert.equal(withinRadius(LA, INGLEWOOD, 50), true);
  assert.equal(withinRadius(LA, SAN_DIEGO, 50), false);
});

test('metroRadiusMiles: defaults to 50, and reads METRO_RADIUS_MILES when it is a positive number', () => {
  assert.equal(metroRadiusMiles({}), 50);
  assert.equal(metroRadiusMiles({ METRO_RADIUS_MILES: '25' }), 25);
  assert.equal(metroRadiusMiles({ METRO_RADIUS_MILES: '0' }), 50);
  assert.equal(metroRadiusMiles({ METRO_RADIUS_MILES: 'far' }), 50);
});
