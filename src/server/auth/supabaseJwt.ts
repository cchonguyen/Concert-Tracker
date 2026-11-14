// The short-lived Supabase token the Worker makes for a signed-in member, so
// Postgres row level security sees who is asking (auth.uid() = sub). Signed
// here with the project's JWT secret (HS256, Web Crypto), so making one costs
// no request. It lives 60 seconds: long enough for one API request.

export const SUPABASE_TOKEN_SECONDS = 60;

const enc = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encJson = (o: unknown) => enc(new TextEncoder().encode(JSON.stringify(o)));

// Finished keys only: a cached in-flight promise would be awaited by a later
// request and can never settle once the request that made it has ended.
const keyCache = new Map<string, CryptoKey>();
async function hmacKey(secret: string): Promise<CryptoKey> {
  const hit = keyCache.get(secret);
  if (hit) return hit;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache.set(secret, key);
  return key;
}

export async function mintSupabaseToken(user: { userId: string; email: string }, secret: string, now = Date.now()): Promise<string> {
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is not set.');
  if (!user.userId) throw new Error('A Supabase token needs a user id.');
  const iat = Math.floor(now / 1000);
  const payload = { sub: user.userId, email: user.email, role: 'authenticated', aud: 'authenticated', iat, exp: iat + SUPABASE_TOKEN_SECONDS };
  const data = `${encJson({ alg: 'HS256', typ: 'JWT' })}.${encJson(payload)}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return `${data}.${enc(new Uint8Array(sig))}`;
}
