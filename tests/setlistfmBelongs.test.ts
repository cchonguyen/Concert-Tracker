import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belongsToEvent, Setlist } from '../src/server/lineup/adapters/setlistfm.ts';

test('belongsToEvent: matching venue with matching artist or tour returns true', () => {
  // Matching artist at venue
  const artistMatch: Setlist = {
    venue: { name: 'Brooklyn Mirage' },
    artist: { name: 'Charlotte de Witte' },
  };
  assert.equal(belongsToEvent(artistMatch, 'Charlotte de Witte', 'Brooklyn Mirage'), true);

  // Matching tour at venue
  const tourMatch: Setlist = {
    venue: { name: 'Brooklyn Mirage' },
    artist: { name: 'Charlotte de Witte' },
    tour: { name: 'Techno Night Tour' },
  };
  assert.equal(belongsToEvent(tourMatch, 'Techno Night', 'Brooklyn Mirage'), true);

  // Single artist concert at arena
  const arenaShow: Setlist = {
    venue: { name: 'Climate Pledge Arena' },
    artist: { name: 'Odesza' },
  };
  assert.equal(belongsToEvent(arenaShow, 'Odesza', 'Climate Pledge Arena'), true);

  // Festival with setlist info matching
  const infoMatch: Setlist = {
    venue: { name: 'Brooklyn Mirage' },
    artist: { name: 'DJ Heartstring' },
    info: 'Boiler Room New York 2024',
  };
  assert.equal(belongsToEvent(infoMatch, 'Boiler Room', 'Brooklyn Mirage'), true);
});

test('belongsToEvent: matching venue with completely unrelated concurrent artist/event returns false', () => {
  // Unrelated concurrent show at multi-room venue (Brooklyn Mirage / Kings Hall complex)
  const concurrentAmbient: Setlist = {
    venue: { name: 'Brooklyn Mirage' },
    artist: { name: 'Ambient Artist' },
  };
  assert.equal(belongsToEvent(concurrentAmbient, 'Techno Night', 'Brooklyn Mirage'), false);

  // Sub-room in complex (e.g. Kings Hall) with unrelated act
  const kingsHallAct: Setlist = {
    venue: { name: 'Kings Hall at Avant Gardner' },
    artist: { name: 'Jazz Ensemble' },
    tour: { name: 'Acoustic Sessions' },
  };
  assert.equal(belongsToEvent(kingsHallAct, 'Cityfox Experience', 'Kings Hall at Avant Gardner'), false);

  // Unrelated concurrent arena event (e.g. The O2)
  const unrelatedArena: Setlist = {
    venue: { name: 'The O2 Arena' },
    artist: { name: 'Corporate Gala Choir' },
  };
  assert.equal(belongsToEvent(unrelatedArena, 'Arctic Monkeys', 'The O2 Arena'), false);

  // Venue alone without artist or tour info never accepted
  const venueOnly: Setlist = {
    venue: { name: 'Brooklyn Mirage' },
  };
  assert.equal(belongsToEvent(venueOnly, 'Techno Night', 'Brooklyn Mirage'), false);
});

test('belongsToEvent: non-matching venue returns true or false according to rules', () => {
  // Non-matching venue (e.g. abbreviation) where event name words match tour/venue
  const abbreviatedVenue: Setlist = {
    tour: { name: 'EDC Las Vegas 2025' },
    venue: { name: 'LVMS' },
  };
  assert.equal(belongsToEvent(abbreviatedVenue, 'EDC Las Vegas', 'Las Vegas Motor Speedway'), true);

  // Omitted venue parameter where tour matches event name
  assert.equal(belongsToEvent(abbreviatedVenue, 'EDC Las Vegas'), true);

  // Non-matching venue where event name words do NOT match
  const clubShow: Setlist = {
    venue: { name: 'Omnia Nightclub' },
    artist: { name: 'Random Resident DJ' },
  };
  assert.equal(belongsToEvent(clubShow, 'EDC Las Vegas', 'Las Vegas Motor Speedway'), false);

  // Non-matching venue where artist is completely different and no tour matches
  const unrelatedOtherVenue: Setlist = {
    venue: { name: 'Madison Square Garden' },
    artist: { name: 'Billy Joel' },
  };
  assert.equal(belongsToEvent(unrelatedOtherVenue, 'Techno Night', 'Brooklyn Mirage'), false);
});
