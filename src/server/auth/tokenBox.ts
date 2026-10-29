// A member's saved Google sign-in, sealed with AES-GCM under a key held only as
// a Worker secret (SHEETS_TOKEN_ENC_KEY, 32 random bytes in base64). The
// member's user id is the associated data, so a sealed token copied into
// another member's row will not open. This protects the token at rest in the
// database; whoever runs the Worker can still use it, which the privacy notes
// say plainly.

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = unb64(secret.trim());
  if (raw.length !== 32) throw new Error('SHEETS_TOKEN_ENC_KEY must be 32 random bytes in base64 (openssl rand -base64 32).');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealToken(secret: string, userId: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(userId) }, await importKey(secret), te.encode(token)));
  return `t1:${b64(iv)}:${b64(ct)}`;
}

export async function openToken(secret: string, userId: string, sealed: string): Promise<string> {
  const [tag, iv, ct] = sealed.split(':');
  if (tag !== 't1' || !iv || !ct) throw new Error('Unreadable saved sign-in.');
  try {
    return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: te.encode(userId) }, await importKey(secret), unb64(ct)));
  } catch {
    throw new Error('The saved Google sign-in could not be opened. Sign in to Google Sheets again.');
  }
}
