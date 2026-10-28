import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVerbatim } from '../src/verbatim.ts';

const source = 'Your tickets for Big Show at The Fillmore — Sat Aug 29';

test('a value inside its quote, and the quote inside the source, passes', () => {
  assert.equal(isVerbatim('Big Show', 'Your tickets for Big Show at The Fillmore', source), true);
});

test('a quote that is not in the source fails', () => {
  assert.equal(isVerbatim('Big Show', 'Big Show at Madison Square', source), false);
});

test('a value that is not in its quote fails', () => {
  assert.equal(isVerbatim('Other Act', 'Your tickets for Big Show at The Fillmore', source), false);
});

test('partial words do not match', () => {
  assert.equal(isVerbatim('Show', 'Big Showcase', 'Big Showcase'), false);
});
