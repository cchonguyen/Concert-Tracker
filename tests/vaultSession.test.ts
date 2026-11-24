import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VaultMaterial } from '../src/services/vault.ts';
import { noteView, VaultSession, type VaultServer } from '../src/services/vaultSession.ts';

const FAST = 1000;

// A fake server that keeps what the real one would: the wrapped key material.
function fakeServer() {
  let material: VaultMaterial | null = null;
  const server: VaultServer = {
    get: async () => ({ state: material ? 'encrypted' : 'plaintext', material }),
    turnOn: async (m) => {
      if (material) throw new Error('already on');
      material = m;
    },
    rewrap: async (m) => {
      material = m;
    },
  };
  return { server, stored: () => material };
}

test('vault: a single-owner install is unavailable and never calls the server', async () => {
  const s = new VaultSession({ get: async () => assert.fail('no call'), turnOn: async () => assert.fail('no call'), rewrap: async () => assert.fail('no call') }, false);
  await s.load();
  assert.equal(s.status, 'unavailable');
});

test('vault state machine: uninitialized, setup, unlocked, locked, wrong secret, passphrase rotation, recovery-key unlock', async () => {
  const { server, stored } = fakeServer();
  const seen: string[] = [];
  const s = new VaultSession(server, true, FAST);
  s.subscribe(() => seen.push(s.status));
  assert.equal(s.status, 'loading');
  await s.load();
  assert.equal(s.status, 'off'); // uninitialized

  const recovery = await s.setUp('first passphrase');
  assert.equal(s.status, 'unlocked');
  assert.ok(stored());
  await assert.rejects(s.setUp('again again'), /already on/);

  const cipher = await s.encryptNote('met Jen at the barrier');
  assert.ok(cipher.startsWith('v1:') && !cipher.includes('Jen'));
  assert.equal(await s.readNote(cipher), 'met Jen at the barrier');
  assert.equal(await s.readNote('old plaintext note'), 'old plaintext note'); // not yet encrypted
  assert.equal(await s.readNote(''), '');

  s.lock();
  assert.equal(s.status, 'locked');
  assert.equal(await s.readNote(cipher), null); // locked, not empty
  await assert.rejects(s.encryptNote('x'), /Unlock the vault/);
  await assert.rejects(s.unlock({ passphrase: 'wrong wrong wrong' }), /Wrong passphrase/);
  assert.equal(s.status, 'locked');

  await s.unlock({ passphrase: 'first passphrase' });
  assert.equal(await s.readNote(cipher), 'met Jen at the barrier');

  // Rotation re-wraps the master secret: old ciphertext still opens, the old passphrase no longer does.
  await s.changePassphrase({ passphrase: 'first passphrase' }, 'second passphrase');
  s.lock();
  await assert.rejects(s.unlock({ passphrase: 'first passphrase' }), /Wrong passphrase/);
  await s.unlock({ passphrase: 'second passphrase' });
  assert.equal(await s.readNote(cipher), 'met Jen at the barrier');

  // The Base58 recovery key opens it from a cold start, as after a reload.
  const fresh = new VaultSession(server, true, FAST);
  await fresh.load();
  assert.equal(fresh.status, 'locked');
  await assert.rejects(fresh.unlock({ recoveryKey: recovery.slice(0, -5) }), /valid recovery key/);
  await fresh.unlock({ recoveryKey: recovery });
  assert.equal(await fresh.readNote(cipher), 'met Jen at the barrier');
  await fresh.changePassphrase({ recoveryKey: recovery }, 'third passphrase');
  fresh.lock();
  await fresh.unlock({ passphrase: 'third passphrase' });
  assert.deepEqual(seen.slice(0, 3), ['off', 'unlocked', 'locked']);
});

test('locked notes show "🔒 Vault locked", never an empty box, and cannot be edited', async () => {
  assert.deepEqual(noteView(null), { kind: 'locked', badge: '🔒 Vault locked', editable: false });
  assert.deepEqual(noteView(''), { kind: 'text', text: '', editable: true });
  assert.deepEqual(noteView('hello'), { kind: 'text', text: 'hello', editable: true });
});

test('export: the browser opens notes and people into a readable file', async () => {
  const { createVault, encryptField } = await import('../src/services/vault.ts');
  const { decryptBundle, hasCiphertext } = await import('../src/services/exportBundle.ts');
  const v = await createVault('export passphrase', FAST);
  const bundle = {
    events: [
      { id: 'e1', name: 'Show', notes: await encryptField(v.keys, 'great night'), companions: [], personIds: ['p1', 'p2'] },
      { id: 'e2', name: 'Old', notes: 'plain note', companions: ['Sam'] },
    ],
    records: [
      { id: 'p1', kind: 'person', name: '', nameEncrypted: await encryptField(v.keys, 'Jen'), attrs: { enc: await encryptField(v.keys, JSON.stringify({ note: 'from work' })) } },
      { id: 'p2', kind: 'person', name: '', nameEncrypted: await encryptField(v.keys, 'Pat'), attrs: {} },
      { id: 'v1', kind: 'venue', name: 'Forum', attrs: {} },
    ],
  };
  assert.ok(hasCiphertext(bundle));
  const out = await decryptBundle(bundle, v.keys);
  assert.deepEqual(out.events!.map((e) => [e.notes, e.companions]), [['great night', ['Jen', 'Pat']], ['plain note', ['Sam']]]);
  assert.deepEqual(out.records!.map((r) => [r.kind, r.name, r.attrs]), [['person', 'Jen', { note: 'from work' }], ['person', 'Pat', {}], ['venue', 'Forum', {}]]);
  assert.ok(!JSON.stringify(out).includes('nameEncrypted') && !JSON.stringify(out).includes('v1:'));
});
