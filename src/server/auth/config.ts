import { type AccessConfig, accessConfigFromEnv } from '../share/access';
import type { MemberDirectory } from './members';

// Who may use /api. Every request is checked; nothing is open by default.
//  - MULTI_USER=on (exactly, after trimming): members. Every /api request
//    needs an invited member, and the request's rows are that member's alone
//    (see ARCHITECTURE.md, "Multi-user"). Needs the Access settings, the
//    Supabase settings, and a directory of members.
//  - Anything else (unset, "off", or a value that cannot be read as "on"):
//    the single-owner app. Only the Access identity in OWNER_EMAIL gets through.
//  - Anything missing for the mode above: closed. Every /api request gets 503,
//    except /api/health, which says only that the server is up.

export interface MultiUserConfig {
  access: AccessConfig;
  supabaseUrl: string;
  anonKey: string;
  jwtSecret: string;
}

export interface OwnerGate {
  access: AccessConfig;
  ownerEmail: string;
  getJson?: (url: string) => Promise<unknown>;
}

export type AccessGate =
  | ({ kind: 'multi'; directory: MemberDirectory } & MultiUserConfig)
  | ({ kind: 'owner' } & OwnerGate)
  | { kind: 'local' } // the Node dev server on loopback only (localOwnerFromEnv)
  | { kind: 'closed'; reason: string };

export function multiUserFromEnv(env: Record<string, string | undefined>): MultiUserConfig | null {
  if (env.MULTI_USER?.trim().toLowerCase() !== 'on') return null;
  const access = accessConfigFromEnv(env);
  const missing = [
    !access && 'ACCESS_TEAM_DOMAIN and ACCESS_AUD',
    !env.SUPABASE_URL && 'SUPABASE_URL',
    !env.SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY',
    !env.SUPABASE_JWT_SECRET && 'SUPABASE_JWT_SECRET',
  ].filter(Boolean);
  // Half-configured is refused loudly rather than quietly running single-owner.
  if (missing.length) throw new Error(`MULTI_USER=on needs ${missing.join(', ')}.`);
  return { access: access!, supabaseUrl: env.SUPABASE_URL!, anonKey: env.SUPABASE_ANON_KEY!, jwtSecret: env.SUPABASE_JWT_SECRET! };
}

// The gate for this process. `directory` is called only in multi-user mode, so
// the members table is not touched in single-owner mode. Never throws: a
// config that cannot be read becomes a closed gate.
export function accessGateFromEnv(env: Record<string, string | undefined>, directory: () => MemberDirectory): AccessGate {
  const raw = env.MULTI_USER?.trim().toLowerCase();
  if (raw === 'on') {
    try {
      const config = multiUserFromEnv(env)!;
      return { kind: 'multi', ...config, directory: directory() };
    } catch (err) {
      return { kind: 'closed', reason: err instanceof Error ? err.message : String(err) };
    }
  }
  if (raw !== undefined && raw !== '' && raw !== 'off') {
    console.warn(`MULTI_USER is "${raw}", which is not "on" or "off". Running single-owner.`);
  }
  const access = accessConfigFromEnv(env);
  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase() ?? '';
  const missing = [!access && 'ACCESS_TEAM_DOMAIN and ACCESS_AUD', !ownerEmail && 'OWNER_EMAIL'].filter(Boolean);
  if (missing.length) return { kind: 'closed', reason: `Single-owner access needs ${missing.join(' and ')}.` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) return { kind: 'closed', reason: 'OWNER_EMAIL is not an email address.' };
  return { kind: 'owner', access: access!, ownerEmail };
}

// The Worker's settings: the process environment (vars and secrets, as
// nodejs_compat fills it) and the bindings the Worker was handed. Both are
// read, so MULTI_USER cannot be on in one and missing from the other and leave
// the app running single-owner. A string in the bindings wins over the process
// environment only when the process environment does not have it.
export function workerSettings(bindings: Record<string, unknown>, processEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const fromBindings = Object.fromEntries(Object.entries(bindings).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return { ...fromBindings, ...processEnv };
}

// Local development only: the Node dev server (server.ts) on this machine, with
// no Access sign-in. It is refused (returns null) in production, and only the
// Node server asks for it, so the Worker can never be in this mode. The server
// listens on 127.0.0.1 in this mode (see gate.ts, localOwnerMiddleware).
export function localOwnerFromEnv(env: Record<string, string | undefined>): boolean {
  if (env.LOCAL_DEV_OWNER?.trim().toLowerCase() !== 'on') return false;
  if (env.NODE_ENV === 'production') {
    console.warn('LOCAL_DEV_OWNER is ignored in production.');
    return false;
  }
  return true;
}
