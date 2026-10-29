// Sample mode: the app runs read-only over the fictional sample data in src/demo/.
// It is chosen once, at start-up (startMode), and never because a request
// failed: a network error or a 5xx is an error screen, not sample data.
// Sample data is loaded by a dynamic import in activateSample, so members never
// download it. See ARCHITECTURE.md, Public pages.

import type { Me } from '../components/MeContext';

export type SampleMode = 'demo' | 'not-invited';
export interface SampleStart {
  mode: SampleMode;
  email: string | null;
}
export type Start = { kind: 'member'; me: Me } | ({ kind: 'sample' } & SampleStart) | { kind: 'error'; message: string };

// Answers the sample's reads and refuses its writes (src/demo/sampleApi.ts).
export interface SampleSource {
  me: Me;
  answer(url: string): unknown;
}

// Thrown for a write in sample mode, or a read the sample does not have.
export class SampleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleRefused';
  }
}

export const SAMPLE_WRITE_MESSAGE = 'Sample data is read-only. Nothing you do here is saved.';

// The only calls sample mode lets reach the server: a stranger's request
// access state and the ask itself. Every other /api call is refused by the
// server (not_invited) and never sent from sample mode.
const NOT_INVITED_CALLS: Array<[method: string, path: string]> = [
  ['GET', '/api/access-requests/mine'],
  ['POST', '/api/access-requests'],
];

let source: SampleSource | null = null;
let blockedWrite: ((action?: string) => void) | null = null;

export const sampleSource = (): SampleSource | null => source;
export const isSampleMode = (): boolean => source !== null;
export const isNotInvited = (): boolean => source?.me.sample === 'not-invited';

// The app's explainer registers here; a write that a control did not check first lands here.
export function setBlockedWriteHandler(handler: ((action?: string) => void) | null): void {
  blockedWrite = handler;
}

export function reportBlockedWrite(): void {
  blockedWrite?.();
}

// Calls sample mode may send to the real server. Everything else stays local.
export function allowedInSample(method: string, path: string): boolean {
  return isNotInvited() && NOT_INVITED_CALLS.some(([m, p]) => m === method && p === path);
}

// Who the app is, decided before anything loads. /demo is sample mode with no
// server call. /app asks "who am I": a member gets the archive, an explicit
// not_invited answer gets sample mode with the request banner, and anything
// else is an error.
export async function startMode(pathname: string, whoAmI: () => Promise<Me>): Promise<Start> {
  if (pathname === '/demo' || pathname === '/demo/') return { kind: 'sample', mode: 'demo', email: null };
  try {
    return { kind: 'member', me: await whoAmI() };
  } catch (err) {
    const e = err as { code?: string; email?: string; message?: string };
    if (e?.code === 'not_invited') return { kind: 'sample', mode: 'not-invited', email: e.email ?? null };
    return { kind: 'error', message: e?.message || 'The server did not answer.' };
  }
}

// Loads the sample (a separate chunk) and turns sample mode on for this page.
export async function activateSample(start: SampleStart): Promise<SampleSource> {
  const { createSampleSource } = await import('../demo/sampleApi');
  source = createSampleSource(start);
  installFetchGuard();
  return source;
}

// Second line of defence: a fetch to /api in sample mode fails, whichever
// module makes it. lineupApi already answers from the sample, so this only
// catches a direct fetch that someone adds later.
function installFetchGuard(): void {
  if (typeof window === 'undefined' || (window.fetch as { sampleGuard?: boolean }).sampleGuard) return;
  const inner = window.fetch.bind(window);
  const guard: typeof fetch & { sampleGuard?: boolean } = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = new URL(url, 'http://localhost').pathname;
    if ((path === '/api' || path.startsWith('/api/')) && !allowedInSample(method, path)) {
      return Promise.reject(new SampleRefused(`Sample data makes no server calls (${method} ${path}).`));
    }
    return inner(input, init);
  };
  guard.sampleGuard = true;
  window.fetch = guard;
}
