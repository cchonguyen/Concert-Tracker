import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeForVenue } from '../src/services/venuePlace.ts';

test('your other events at the venue agreeing on one place give it, with state and country', () => {
  const events = [
    { venue: 'The Sphere', city: 'Las Vegas' },
    { venue: 'the sphere ', city: 'Las Vegas', region: 'NV', country: 'United States' },
    { venue: 'Other', city: 'Reno' },
  ];
  assert.deepEqual(placeForVenue(events, 'The Sphere'), { city: 'Las Vegas', region: 'NV', country: 'United States' });
});

test('events at the venue in two cities, or none, give nothing', () => {
  assert.equal(placeForVenue([{ venue: 'The Fillmore', city: 'San Francisco' }, { venue: 'The Fillmore', city: 'Denver' }], 'The Fillmore'), undefined);
  assert.equal(placeForVenue([{ venue: 'The Fillmore' }], 'The Fillmore'), undefined);
  assert.equal(placeForVenue([], ' '), undefined);
});
