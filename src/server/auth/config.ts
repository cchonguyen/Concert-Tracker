import { type AccessConfig, accessConfigFromEnv } from '../share/access';

// Multi-user mode is off unless MULTI_USER=on and everything it needs is
// set. Off, the app is the single-owner app it has always been. On, every
// /api request needs a signed-in member, and the request's rows are that
// member's alone (see ARCHITECTURE.md, "Multi-user").

export interface MultiUserConfig {
  access: AccessConfig;
  supabaseUrl: string;
  anonKey: string;
  jwtSecret: string;
}

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
