// Runs an async start-up once per isolate and keeps only the finished value.
// A Worker must never hand one request a promise another request created: if
// that request ends first, the promise can never settle ("This promise was
// created by a request that has since ended"). A request that finds a start in
// progress waits on its own timers and checks again; one that finds the start
// stale (its request is gone) takes it over.
export interface SettledOnce<T, A> {
  get(arg: A): Promise<T>;
  reset(): void;
}

export function settledOnce<T, A = void>(init: (arg: A) => Promise<T>, opts: { pollMs?: number; staleMs?: number } = {}): SettledOnce<T, A> {
  const pollMs = opts.pollMs ?? 20;
  const staleMs = opts.staleMs ?? 20_000;
  let done: { value: T } | null = null;
  let startedAt: number | null = null;
  let generation = 0;
  return {
    async get(arg: A): Promise<T> {
      for (;;) {
        if (done) return done.value;
        if (startedAt === null || Date.now() - startedAt > staleMs) {
          const mine = generation;
          const started = (startedAt = Date.now());
          try {
            const value = await init(arg);
            if (mine === generation) done = { value };
            return value;
          } finally {
            if (startedAt === started) startedAt = null;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    reset() {
      generation++;
      done = null;
      startedAt = null;
    },
  };
}
