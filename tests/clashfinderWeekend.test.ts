import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysBetween,
  matchEdition,
  parseEventList,
  weekendFromName,
} from '../src/server/lineup/adapters/clashfinder.ts';

test('weekendFromName extracts weekend numbers from names and slugs', () => {
  assert.equal(weekendFromName('Coachella Weekend 1'), 1);
  assert.equal(weekendFromName('Coachella Weekend 2'), 2);
  assert.equal(weekendFromName('Coachella W1'), 1);
  assert.equal(weekendFromName('Coachella W2'), 2);
  assert.equal(weekendFromName('Coachella Wknd 1'), 1);
  assert.equal(weekendFromName('Coachella Wknd 2'), 2);
  assert.equal(weekendFromName('coachella2024w1'), 1);
  assert.equal(weekendFromName('coachella2024w2'), 2);
  assert.equal(weekendFromName('coachella-w1'), 1);
  assert.equal(weekendFromName('coachella_w2'), 2);
  assert.equal(weekendFromName('tomorrowland-weekend-2'), 2);
  assert.equal(weekendFromName('Portola Music Festival'), null);
  assert.equal(weekendFromName('EDC Las Vegas'), null);
  assert.equal(weekendFromName('Power 106'), null);
});

test('daysBetween calculates absolute day difference', () => {
  assert.equal(daysBetween('2024-04-19', '2024-04-19'), 0);
  assert.equal(daysBetween('2024-04-17', '2024-04-19'), 2);
  assert.equal(daysBetween('2024-04-21', '2024-04-19'), 2);
  assert.equal(daysBetween('2024-04-12', '2024-04-19'), 7);
  assert.equal(daysBetween('2024-04-22', '2024-04-19'), 3);
});

test('Coachella W1 vs W2: searching with Weekend 2 start date picks Weekend 2 edition even if W1 has more edits', () => {
  const list = parseEventList({
    coachella2024w1: {
      name: 'coachella2024w1',
      desc: 'Coachella 2024 Weekend 1',
      startDate: '2024-04-12',
      edits: 900,
      numActs: 150,
      private: 0,
    },
    coachella2024w2: {
      name: 'coachella2024w2',
      desc: 'Coachella 2024 Weekend 2',
      startDate: '2024-04-19',
      edits: 300,
      numActs: 150,
      private: 0,
    },
  });

  // Searching with W2 start date picks W2 despite W1 having 900 edits vs 300
  const matchW2 = matchEdition(list, 'Coachella', 2024, '2024-04-19');
  assert.equal(matchW2?.slug, 'coachella2024w2');

  // Searching with W1 start date picks W1
  const matchW1 = matchEdition(list, 'Coachella', 2024, '2024-04-12');
  assert.equal(matchW1?.slug, 'coachella2024w1');

  // Searching with options object containing startDate works identically
  const matchWithOptions = matchEdition(list, 'Coachella', 2024, { startDate: '2024-04-19' });
  assert.equal(matchWithOptions?.slug, 'coachella2024w2');
});

test('Coachella W1 vs W2: weekend token in query disambiguates without startDate', () => {
  const list = parseEventList({
    coachella2024w1: {
      name: 'coachella2024w1',
      desc: 'Coachella 2024 Weekend 1',
      startDate: '2024-04-12',
      edits: 900,
      numActs: 150,
    },
    coachella2024w2: {
      name: 'coachella2024w2',
      desc: 'Coachella 2024 Weekend 2',
      startDate: '2024-04-19',
      edits: 300,
      numActs: 150,
    },
  });

  // "Weekend 2" rejects W1 and matches W2
  assert.equal(matchEdition(list, 'Coachella Weekend 2', 2024)?.slug, 'coachella2024w2');
  // "W2" rejects W1 and matches W2
  assert.equal(matchEdition(list, 'Coachella W2', 2024)?.slug, 'coachella2024w2');
  // "W1" rejects W2 and matches W1
  assert.equal(matchEdition(list, 'Coachella W1', 2024)?.slug, 'coachella2024w1');
});

test('title matching with "Music Festival" in query successfully matches an edition titled without "Music Festival"', () => {
  const list = parseEventList({
    portola2023: {
      name: 'portola2023',
      desc: 'Portola 2023',
      startDate: '2023-09-30',
      edits: 80,
      numActs: 60,
    },
  });

  // "Portola Music Festival" matches "Portola 2023"
  const match = matchEdition(list, 'Portola Music Festival', 2023);
  assert.equal(match?.slug, 'portola2023');

  // Other festival stop-words also match
  assert.equal(matchEdition(list, 'Portola Festival', 2023)?.slug, 'portola2023');
  assert.equal(matchEdition(list, 'Portola Arts and Music Festival', 2023)?.slug, 'portola2023');
  assert.equal(matchEdition(list, 'Annual Portola Music Festival', 2023)?.slug, 'portola2023');
});

test('speculative and fantasy clashes remain rejected even with matching date and high edits', () => {
  const list = parseEventList({
    coachella2024fantasy: {
      name: 'coachella2024fantasy',
      desc: 'Coachella 2024 (Fantasy Lineup)',
      startDate: '2024-04-19',
      edits: 9999,
      numActs: 200,
    },
    coachella2024real: {
      name: 'coachella2024real',
      desc: 'Coachella 2024 Weekend 2',
      startDate: '2024-04-19',
      edits: 50,
      numActs: 150,
    },
  });

  const match = matchEdition(list, 'Coachella', 2024, '2024-04-19');
  assert.equal(match?.slug, 'coachella2024real');
});
