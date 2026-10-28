// Checks the token Cloudflare Access adds to every request it lets through
// after sign-in (Cf-Access-Jwt-Assertion). Access already stands in front of
// the site; this is a second lock inside the Worker, so a request that got
// past Access some other way (a path trick on the share page's bypass) is
// still refused. Turned on by ACCESS_TEAM_DOMAIN and ACCESS_AUD; with either
// missing the Worker relies on Access alone, as before.

export interface AccessConfig {
  teamDomain: string; // https://<team>.cloudflareaccess.com
  aud: string; // the Access application's audience tag
}

export function accessConfigFromEnv(env: Record<string, string | undefined>): AccessConfig | null {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) return null;
  return { teamDomain: (team.startsWith('https://') ? team : `https://${team}`).replace(/\/+$/, ''), aud };
}

type Jwk = JsonWebKey & { kid?: string };
type GetJson = (url: string) => Promise<unknown>;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

// Signing keys, per team, for an hour; fetched again when a token names a
// key not held.
const keyCache = new Map<string, { keys: Jwk[]; until: number }>();

async function keysFor(config: AccessConfig, getJson: GetJson, now: number, refresh: boolean): Promise<Jwk[]> {
  const hit = keyCache.get(config.teamDomain);
  if (hit && hit.until > now && !refresh) return hit.keys;
  const body = (await getJson(`${config.teamDomain}/cdn-cgi/access/certs`)) as { keys?: Jwk[] };
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  keyCache.set(config.teamDomain, { keys, until: now + 3_600_000 });
  return keys;
}

export const clearAccessKeys = () => keyCache.clear();

const defaultGetJson: GetJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Access keys: HTTP ${res.status}`);
  return res.json();
};

// True only for a well-formed RS256 token signed by one of the team's keys,
// for this application, from this team, and not expired.
export async function verifyAccessToken(token: string | null | undefined, config: AccessConfig, now = Date.now(), getJson = defaultGetJson): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = json(parts[0]);
    const payload = json(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(config.aud)) return false;
    if (payload.iss !== config.teamDomain) return false;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return false;
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now + 60_000) return false;
    let jwk = (await keysFor(config, getJson, now, false)).find((k) => k.kid === header.kid);
    jwk ??= (await keysFor(config, getJson, now, true)).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}
