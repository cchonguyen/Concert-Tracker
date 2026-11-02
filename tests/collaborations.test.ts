import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { newEvent } from '../src/server/events/service.ts';
import {
  listCollaborations,
  saveCollaboration,
  removeCollaboration,
} from '../src/server/entities/collaborations.ts';
import { undoEntry } from '../src/server/entities/manage.ts';

test('collaborations: list, save, event propagation, and remove', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'collab-test-'));
  try {
    const store = new FileLineupStore(dir);

    // Initial event with a John Summit & Subtronics B2B set (initially without an alias)
    const slotId = 'slot-summit-subtronics';
    const event = {
      ...newEvent('Lost Lands 2024', new Date('2024-09-20')),
      seen: [
        {
          id: 'act-1',
          key: 'john summit',
          name: 'John Summit',
          slotId,
          b2b: ['subtronics'],
          from: 'lineup' as const,
        },
        {
          id: 'act-2',
          key: 'subtronics',
          name: 'Subtronics',
          slotId,
          b2b: ['john summit'],
          from: 'lineup' as const,
        },
      ],
    };
    await store.putEvent(event);

    // 1. Initial collaborations list is empty
    const initialList = await listCollaborations(store);
    assert.equal(initialList.length, 0);

    // 2. Save collaboration: Subjohnics
    const { record, entry } = await saveCollaboration(store, {
      alias: 'Subjohnics',
      partners: ['John Summit', 'Subtronics'],
    });

    assert.equal(record.alias, 'Subjohnics');
    assert.deepEqual(record.partners, ['John Summit', 'Subtronics']);
    assert.equal(record.canonicalName, 'John Summit b2b Subtronics');
    assert.ok(entry.id);

    // 3. Verify list now returns Subjohnics
    const updatedList = await listCollaborations(store);
    assert.equal(updatedList.length, 1);
    assert.equal(updatedList[0].alias, 'Subjohnics');
    assert.deepEqual(updatedList[0].partners, ['John Summit', 'Subtronics']);

    // 4. Verify event propagation: event.seen acts now carry alias = 'Subjohnics'
    const storedEvent = await store.getEvent(event.id);
    assert.ok(storedEvent);
    assert.equal(storedEvent.seen.length, 2);
    assert.equal(storedEvent.seen[0].alias, 'Subjohnics');
    assert.equal(storedEvent.seen[1].alias, 'Subjohnics');

    // 5. Remove collaboration
    const { entry: removeEntry } = await removeCollaboration(store, 'Subjohnics');
    assert.ok(removeEntry.id);

    const emptyList = await listCollaborations(store);
    assert.equal(emptyList.length, 0);

    const clearedEvent = await store.getEvent(event.id);
    assert.ok(clearedEvent);
    assert.equal(clearedEvent.seen[0].alias, undefined);
    assert.equal(clearedEvent.seen[1].alias, undefined);

    // 6. Verify Undo: undoing the remove restores the alias on the event
    await undoEntry(store, removeEntry.id);
    const restoredEvent = await store.getEvent(event.id);
    assert.ok(restoredEvent);
    assert.equal(restoredEvent.seen[0].alias, 'Subjohnics');
    assert.equal(restoredEvent.seen[1].alias, 'Subjohnics');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
