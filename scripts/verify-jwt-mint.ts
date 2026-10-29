// Dry run for the Supabase token the Worker mints (src/server/auth/supabaseJwt.ts).
// Run it against the project BEFORE setting MULTI_USER=on:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_JWT_SECRET=... \
//     npx tsx scripts/verify-jwt-mint.ts --user-id <the owner's auth.users id> [--email you@example.com]
// It only reads. It checks that PostgREST accepts a freshly minted token, refuses a
// tampered one and an expired one, and that rows RLS lets through belong to that
// user (so auth.uid() equals the token's sub). Exit code 0 only when nothing failed.

import { mintSupabaseToken } from '../src/server/auth/supabaseJwt';

export interface Check {
  name: string;
  status: 'pass' | 'fail' | 'inconclusive';
  detail: string;
}

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

export async function verifyJwtMint(
  env: { url: string; anonKey: string; jwtSecret: string; userId: string; email: string },
  fetcher: Fetch = fetch as unknown as Fetch,
  now = Date.now(),
): Promise<Check[]> {
  const base = env.url.replace(/\/$/, '');
  const get = (token: string, path: string) => fetcher(`${base}/rest/v1/${path}`, { headers: { apikey: env.anonKey, authorization: `Bearer ${token}` } });
  const out: Check[] = [];

  const good = await mintSupabaseToken({ userId: env.userId, email: env.email }, env.jwtSecret, now);
  const accepted = await get(good, 'user_settings?select=user_id&limit=50');
  const body = await accepted.text();
  out.push(
    accepted.status === 200
      ? { name: 'minted token accepted', status: 'pass', detail: 'PostgREST answered 200.' }
      : { name: 'minted token accepted', status: 'fail', detail: `PostgREST answered ${accepted.status}: ${body.slice(0, 200)}. Check SUPABASE_JWT_SECRET is the project's JWT secret (Project Settings > API > JWT Secret), not the anon key.` },
  );

  if (accepted.status === 200) {
    let rows: Array<{ user_id?: string }> = [];
    try {
      rows = JSON.parse(body);
    } catch {
      /* leave empty */
    }
    if (!rows.length) out.push({ name: 'auth.uid() matches the token', status: 'inconclusive', detail: 'No user_settings rows are visible to this user yet, so there is nothing to compare. Run `select auth.uid()` while impersonating the token, or save a setting and run again.' });
    else if (rows.every((r) => r.user_id === env.userId)) out.push({ name: 'auth.uid() matches the token', status: 'pass', detail: `${rows.length} visible row(s), all owned by ${env.userId}.` });
    else out.push({ name: 'auth.uid() matches the token', status: 'fail', detail: 'A row owned by someone else was visible. RLS is not limiting to auth.uid(); do not turn multi-user on.' });
  }

  const flipped = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  const tampered = await get(flipped, 'user_settings?select=user_id&limit=1');
  out.push(
    tampered.status === 401
      ? { name: 'tampered token refused', status: 'pass', detail: 'PostgREST answered 401.' }
      : { name: 'tampered token refused', status: 'fail', detail: `Expected 401, got ${tampered.status}.` },
  );

  const old = await mintSupabaseToken({ userId: env.userId, email: env.email }, env.jwtSecret, now - 10 * 60_000);
  const expired = await get(old, 'user_settings?select=user_id&limit=1');
  out.push(
    expired.status === 401
      ? { name: 'expired token refused', status: 'pass', detail: 'PostgREST answered 401 for a 10-minute-old token.' }
      : { name: 'expired token refused', status: 'fail', detail: `Expected 401, got ${expired.status}.` },
  );
  return out;
}

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const env = {
    url: process.env.SUPABASE_URL ?? '',
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
    jwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
    userId: arg('user-id') ?? '',
    email: arg('email') ?? 'verify@example.com',
  };
  const missing = Object.entries({ SUPABASE_URL: env.url, SUPABASE_ANON_KEY: env.anonKey, SUPABASE_JWT_SECRET: env.jwtSecret, '--user-id': env.userId }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing: ${missing.join(', ')}`);
    process.exit(2);
  }
  const checks = await verifyJwtMint(env);
  for (const c of checks) console.log(`${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'INCONCLUSIVE'}  ${c.name}: ${c.detail}`);
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}

if (process.argv[1]?.endsWith('verify-jwt-mint.ts')) void main();
