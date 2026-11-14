import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftAfterStoredChange } from '../src/services/fieldDraft.ts';

// Regression: typing into a detail field was wiped by a save reply that
// carried the value from before the latest keystrokes.
test('a field being typed in keeps its draft when an older stored value arrives', () => {
  // Saved "Fo" is still in flight; the person has typed "Foo b" since.
  assert.equal(draftAfterStoredChange('Foo b', 'Fo', true), 'Foo b');
});

test('a field being typed in keeps its draft when the stored value matches it', () => {
  assert.equal(draftAfterStoredChange('Foo', 'Foo', true), 'Foo');
});

test('a field that is not being edited takes the stored value', () => {
  assert.equal(draftAfterStoredChange('old', 'Saved elsewhere', false), 'Saved elsewhere');
});

test('an empty stored value clears a field that is not being edited', () => {
  assert.equal(draftAfterStoredChange('Draft', '', false), '');
});
