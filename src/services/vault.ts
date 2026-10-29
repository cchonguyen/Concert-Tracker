import { norm as normalizeName } from './listImport';

// The vault's cryptography, run in the browser (Web Crypto only). Notes,
// companions and people's names are encrypted here before they are sent; the
// server never holds a key and never writes these fields. Parked behind
// multi-user (see ARCHITECTURE.md, "Multi-user"); nothing calls it yet.
//
// One random 32-byte master secret is the only key material. It is wrapped
// twice (passphrase, recovery key) and, unwrapped, yields two keys by HKDF:
// one for AES-GCM field encryption, one for HMAC lookup tokens. A passphrase
// change re-wraps the master secret and re-encrypts nothing.

export const PBKDF2_ITERATIONS = 600_000;
const FIELD_INFO = 'livearchive-field-v1';
const TOKEN_INFO = 'livearchive-companion-token-v1';
const te = new TextEncoder();
const td = new TextDecoder();

export interface VaultKeys {
  field: CryptoKey; // AES-GCM
  token: CryptoKey; // HMAC-SHA256
}

// What the server stores for a member (user_profiles). Ciphertext and salts
// only; nothing here opens without the passphrase or the recovery key.
export interface VaultMaterial {
  vaultSalt: string; // base64, the HKDF salt
  kdfAlg: 'PBKDF2-SHA256';
  pbkdf2Iterations: number;
  passphraseSalt: string; // base64, the PBKDF2 salt
  wrappedByPassphrase: string; // w1:<iv>:<ciphertext>
  wrappedByRecovery: string;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
type Bytes = Uint8Array<ArrayBuffer>;
const unb64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));

// Base58 (Bitcoin alphabet: no 0, O, I or l), so a printed recovery key has
// no look-alike characters and needs no word list.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('That is not a valid recovery key.');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

// 32 random bytes as Base58 in hyphenated groups of four: easy to print and
// to read back. Capitals and lower case both count.
export function formatRecoveryKey(bytes: Uint8Array): string {
  return (base58Encode(bytes).match(/.{1,4}/g) ?? []).join('-');
}

export function parseRecoveryKey(text: string): Bytes {
  const bytes = base58Decode(text.replace(/[\s-]/g, ''));
  if (bytes.length !== 32) throw new Error('That is not a valid recovery key.');
  return bytes as Bytes;
}

async function wrapKeyFrom(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const recoveryWrapKey = (bytes: Bytes) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function wrap(master: Bytes, key: CryptoKey): Promise<string> {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, master));
  return `w1:${b64(iv)}:${b64(ct)}`;
}

async function unwrap(wrapped: string, key: CryptoKey): Promise<Bytes> {
  const [tag, iv, ct] = wrapped.split(':');
  if (tag !== 'w1' || !iv || !ct) throw new Error('Unreadable vault key.');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct))) as Bytes;
  } catch {
    throw new Error('Wrong passphrase or recovery key.');
  }
}

async function deriveKeys(master: Bytes, vaultSalt: Bytes): Promise<VaultKeys> {
  const root = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: vaultSalt, info: te.encode(info) });
  return {
    field: await crypto.subtle.deriveKey(hkdf(FIELD_INFO), root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    token: await crypto.subtle.deriveKey(hkdf(TOKEN_INFO), root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  };
}

export interface NewVault {
  material: VaultMaterial;
  recoveryKey: string; // shown once; the server never sees it
  keys: VaultKeys;
}

export async function createVault(passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<NewVault> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const master = random(32);
  const vaultSalt = random(16);
  const passphraseSalt = random(16);
  const recovery = random(32);
  return {
    material: {
      vaultSalt: b64(vaultSalt),
      kdfAlg: 'PBKDF2-SHA256',
      pbkdf2Iterations: iterations,
      passphraseSalt: b64(passphraseSalt),
      wrappedByPassphrase: await wrap(master, await wrapKeyFrom(passphrase, passphraseSalt, iterations)),
      wrappedByRecovery: await wrap(master, await recoveryWrapKey(recovery)),
    },
    recoveryKey: formatRecoveryKey(recovery),
    keys: await deriveKeys(master, vaultSalt),
  };
}

export async function unlockWithPassphrase(material: VaultMaterial, passphrase: string): Promise<VaultKeys> {
  const key = await wrapKeyFrom(passphrase, unb64(material.passphraseSalt), material.pbkdf2Iterations);
  return deriveKeys(await unwrap(material.wrappedByPassphrase, key), unb64(material.vaultSalt));
}

export async function unlockWithRecoveryKey(material: VaultMaterial, recoveryKey: string): Promise<VaultKeys> {
  const key = await recoveryWrapKey(parseRecoveryKey(recoveryKey));
  return deriveKeys(await unwrap(material.wrappedByRecovery, key), unb64(material.vaultSalt));
}

// A new passphrase, using the old one or the recovery key. Only the
// passphrase wrapping changes (and the iteration count, raised at unlock if
// OWASP's number has moved): the master secret, the keys, and every
// encrypted row stay as they are.
export async function changePassphrase(
  material: VaultMaterial,
  proof: { passphrase: string } | { recoveryKey: string },
  newPassphrase: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<VaultMaterial> {
  if (newPassphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const master =
    'passphrase' in proof
      ? await unwrap(material.wrappedByPassphrase, await wrapKeyFrom(proof.passphrase, unb64(material.passphraseSalt), material.pbkdf2Iterations))
      : await unwrap(material.wrappedByRecovery, await recoveryWrapKey(parseRecoveryKey(proof.recoveryKey)));
  const passphraseSalt = random(16);
  return {
    ...material,
    pbkdf2Iterations: iterations,
    passphraseSalt: b64(passphraseSalt),
    wrappedByPassphrase: await wrap(master, await wrapKeyFrom(newPassphrase, passphraseSalt, iterations)),
  };
}

// v1:<base64 iv>:<base64 ciphertext>, a fresh random 12-byte IV each time.
export async function encryptField(keys: VaultKeys, plaintext: string): Promise<string> {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.field, te.encode(plaintext)));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptField(keys: VaultKeys, value: string): Promise<string> {
  const [tag, iv, ct] = value.split(':');
  if (tag !== 'v1' || !iv || !ct) throw new Error('Unreadable encrypted field.');
  try {
    return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, keys.field, unb64(ct)));
  } catch {
    throw new Error('This field was not encrypted with your key.');
  }
}

// A lookup token for a typed name: the same name always gives the same token
// for one member, and never the same one for two members (their keys
// differ). It finds a person from a name; it is not the person's identity.
export async function nameToken(keys: VaultKeys, name: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.token, te.encode(normalizeName(name))));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

// True for a stored encrypted field (v1:<iv>:<ciphertext>), as the server
// accepts it in place of a plaintext note.
export const isCiphertext = (v: unknown): v is string => typeof v === 'string' && /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/.test(v);
