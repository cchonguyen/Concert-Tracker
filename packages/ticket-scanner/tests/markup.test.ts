import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readPkpass } from '../src/markup.ts';

// Builds a minimal .pkpass ZIP with one deflated pass.json entry.
function zip(json: unknown): Uint8Array {
  const name = Buffer.from('pass.json');
  const data = deflateRawSync(Buffer.from(JSON.stringify(json)));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, name, data, central, name, end]));
}

test('an event ticket pass yields its name and relevant date', async () => {
  const t = await readPkpass(
    zip({
      relevantDate: '2026-08-29T22:00:00-07:00',
      eventTicket: { primaryFields: [{ key: 'event', label: 'Event', value: 'Big Show' }] },
    }),
  );
  assert.equal(t?.name?.value, 'Big Show');
  assert.equal(t?.date, '2026-08-29T22:00:00-07:00');
});

test('a boarding pass is rejected even with an eventTicket block', async () => {
  const t = await readPkpass(zip({ transitType: 'PKTransitTypeAir', eventTicket: {} }));
  assert.equal(t, null);
});

test('a pass without eventTicket is rejected', async () => {
  assert.equal(await readPkpass(zip({ coupon: {} })), null);
});
