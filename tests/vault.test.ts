import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58Decode, base58Encode, changePassphrase, createVault, decryptField, encryptField, formatRecoveryKey, nameToken, parseRecoveryKey, unlockWithPassphrase, unlockWithRecoveryKey } from '../src/services/vault.ts';

// 1,000 iterations here keeps the suite fast; the default is 600,000.
const FAST = 1000;

test('Base58: round trips, keeps leading zero bytes, refuses look-alike characters', () => {
  for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), crypto.getRandomValues(new Uint8Array(32)), new Uint8Array(32)]) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
  assert.throws(() => base58Decode('0OIl'), /valid recovery key/);
});

test('recovery key: 32 bytes in hyphenated groups of four, read back ignoring hyphens and spaces', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = formatRecoveryKey(bytes);
  assert.ok(key.split('-').slice(0, -1).every((g) => g.length === 4));
  assert.deepEqual(parseRecoveryKey(key), bytes);
  assert.deepEqual(parseRecoveryKey(` ${key.replaceAll('-', ' ')} `), bytes);
  assert.throws(() => parseRecoveryKey(key.slice(0, -4)), /valid recovery key/);
});

test('vault: fields encrypt with a fresh IV, decrypt with the same keys, and nothing readable is stored', async () => {
  const v = await createVault('correct horse battery', FAST);
  const a = await encryptField(v.keys, 'saw them with Jen');
  const b = await encryptField(v.keys, 'saw them with Jen');
  assert.ok(a.startsWith('v1:'));
  assert.notEqual(a, b);
  assert.ok(!a.includes('Jen'));
  assert.equal(await decryptField(v.keys, a), 'saw them with Jen');
  assert.ok(!JSON.stringify(v.material).includes(v.recoveryKey));
  const other = await createVault('another passphrase', FAST);
  await assert.rejects(decryptField(other.keys, a), /not encrypted with your key/);
  await assert.rejects(decryptField(v.keys, 'v1:garbage'), /Unreadable/);
});

test('vault: the passphrase or the recovery key unlocks it; a wrong one does not', async () => {
  const v = await createVault('correct horse battery', FAST);
  const secret = await encryptField(v.keys, 'private note');
  assert.equal(await decryptField(await unlockWithPassphrase(v.material, 'correct horse battery'), secret), 'private note');
  assert.equal(await decryptField(await unlockWithRecoveryKey(v.material, v.recoveryKey), secret), 'private note');
  await assert.rejects(unlockWithPassphrase(v.material, 'wrong passphrase!'), /Wrong passphrase/);
  await assert.rejects(unlockWithRecoveryKey(v.material, formatRecoveryKey(crypto.getRandomValues(new Uint8Array(32)))), /Wrong passphrase or recovery key/);
});

test('vault: changing the passphrase re-wraps only; old rows still open and the old passphrase stops working', async () => {
  const v = await createVault('first passphrase', FAST);
  const secret = await encryptField(v.keys, 'kept as is');
  const next = await changePassphrase(v.material, { passphrase: 'first passphrase' }, 'second passphrase', FAST);
  assert.equal(next.wrappedByRecovery, v.material.wrappedByRecovery);
  assert.equal(next.vaultSalt, v.material.vaultSalt);
  assert.notEqual(next.wrappedByPassphrase, v.material.wrappedByPassphrase);
  assert.equal(await decryptField(await unlockWithPassphrase(next, 'second passphrase'), secret), 'kept as is');
  await assert.rejects(unlockWithPassphrase(next, 'first passphrase'), /Wrong passphrase/);
  const viaRecovery = await changePassphrase(v.material, { recoveryKey: v.recoveryKey }, 'third passphrase', FAST);
  assert.equal(await decryptField(await unlockWithPassphrase(viaRecovery, 'third passphrase'), secret), 'kept as is');
  await assert.rejects(changePassphrase(v.material, { passphrase: 'nope nope nope' }, 'fourth passphrase', FAST), /Wrong passphrase/);
  await assert.rejects(changePassphrase(v.material, { passphrase: 'first passphrase' }, 'short', FAST), /at least 8/);
});

test('name tokens: stable for one member whatever the spelling case, different between members', async () => {
  const mine = await createVault('correct horse battery', FAST);
  const theirs = await createVault('correct horse battery', FAST);
  const t = await nameToken(mine.keys, 'Jennifer Lopez');
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(await nameToken(mine.keys, '  jennifer   LOPEZ '), t);
  assert.notEqual(await nameToken(mine.keys, 'Jen Lopez'), t);
  assert.notEqual(await nameToken(theirs.keys, 'Jennifer Lopez'), t);
  const unlocked = await unlockWithPassphrase(mine.material, 'correct horse battery');
  assert.equal(await nameToken(unlocked, 'Jennifer Lopez'), t);
});
