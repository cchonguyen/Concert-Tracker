import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTintOn, tintHue, TINT_HUES } from '../src/services/eventTint.ts';

test('event tint: every year of a series shares one hue, whatever the event is called', () => {
  const a = tintHue('Desert Sun Weekend', 'Desert Sun Weekend 2022');
  const b = tintHue('Desert Sun Weekend', 'Desert Sun Weekend 2024');
  assert.equal(a, b);
  assert.ok(TINT_HUES.includes(a as (typeof TINT_HUES)[number]));
});

test('event tint: case and spacing do not change the hue', () => {
  assert.equal(tintHue('  harbor   SOUND festival '), tintHue('Harbor Sound Festival'));
});

test('event tint: with no series, the event name picks the hue', () => {
  assert.equal(tintHue(null, 'Ottoline Acoustic Night'), tintHue('Ottoline Acoustic Night'));
  assert.equal(tintHue('', 'Ottoline Acoustic Night'), tintHue('Ottoline Acoustic Night'));
});

test('event tint: no name at all gives no tint rather than a made-up one', () => {
  assert.equal(tintHue(null, null), null);
  assert.equal(tintHue('  ', ''), null);
});

test('event tint: names spread over more than one hue', () => {
  const names = ['Night Tram', 'Brass Harbor', 'Coastline Static', 'DJ Marrow', 'Juniper Choir', 'Lumen Keys', 'Paper Lantern Club', 'Ottoline'];
  assert.ok(new Set(names.map((n) => tintHue(n))).size >= 3);
});

test('event tint: the switch is on by default and off only when turned off', () => {
  assert.equal(parseTintOn(null), true);
  assert.equal(parseTintOn(undefined), true);
  assert.equal(parseTintOn('on'), true);
  assert.equal(parseTintOn('garbage'), true);
  assert.equal(parseTintOn('off'), false);
});
