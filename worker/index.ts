import { handleAsNodeRequest } from 'cloudflare:node';
import { createApiApp, healthStatus } from '../src/server/app';
import { PipelineDeps, runJob } from '../src/server/lineup/pipeline';
import { createDeps, createStore } from '../src/server/lineup/service';
import { backfillEntities, backfillVenuePlaces } from '../src/server/entities/linkingStore';
import { frontDoor, isSignedIn } from '../src/server/share/door';
import { accessConfigFromEnv } from '../src/server/share/access';
import { isRetentionTime, runRetention } from '../src/server/events/retention';
import { accessGateFromEnv, multiUserFromEnv, workerSettings } from '../src/server/auth/config';
import { supabaseMemberStores } from '../src/server/auth/members';
import { getSupabaseClient } from '../src/server/supabase';
import { createEmailNotifier, isDigestTime } from '../src/server/email/notifier';
import { resendFromEnv } from '../src/server/email/sender';
import { supabaseEmailPreferences } from '../src/server/email/store';
import { unsubscribeSecretFromEnv } from '../src/server/email/unsubscribe';
import { redactSecrets } from '../src/server/lineup/http';

// Cloudflare Worker entry. Static files are served from ./dist by Workers
// static assets (wrangler.jsonc); only /api/*, the share page (/s/*) and the
// pages listed in run_worker_first reach this code. frontDoor runs first: it
// answers share page paths and old app addresses itself and, once
// ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, refuses any request that is not a
// public page without a valid Cloudflare Access token. Pages the Worker lets
// through are served from the static assets (ASSETS), and /api goes to Express.
//
// There is no long-lived process, so the Node LookupWorker is replaced by:
// - a Queue: "start" and "try now" send the job id, and the consumer runs it;
// - a Cron Trigger: every minute, jobs that are due (queued or past their
//   quota pause, or cut off while running) are sent to the queue. Duplicate
//   messages are harmless because runJob skips a job that is no longer
//   queued or waiting.
// Each message runs one stage and sends the job back to the queue for the
// next, so every invocation stays within the Workers subrequest limit.

interface LookupMessage {
  jobId: string;
  force?: boolean;
}

interface Env {
  LOOKUP_QUEUE: Queue<LookupMessage>;
  ASSETS: Fetcher;
}

const PORT = 8080;
let depsPromise: Promise<PipelineDeps> | null = null;
let serverPromise: Promise<void> | null = null;

// Built once per isolate. process.env is populated from vars and secrets by
// nodejs_compat. A failed start is retried on the next request. With
// multi-user on, a job whose member is blocked or removed is parked (runJob).
function getDeps(env: Env): Promise<PipelineDeps> {
  depsPromise ??= createStore({ requireSupabase: true })
    .then(createDeps)
    .then((deps) => {
      const settings = workerSettings(env as unknown as Record<string, unknown>, process.env);
      if (settings.MULTI_USER?.trim().toLowerCase() !== 'on') return deps;
      const members = supabaseMemberStores(getSupabaseClient()!);
      return { ...deps, hasActiveUser: (userId: string) => members.hasActiveUser(userId) };
    })
    .catch((err) => {
      depsPromise = null;
      throw err;
    });
  return depsPromise;
}

function ensureServer(env: Env): Promise<void> {
  serverPromise ??= (async () => {
    const deps = await getDeps(env);
    // Who may use /api (src/server/auth/config.ts). Read from the bindings as
    // well as the process environment, so MULTI_USER cannot be on in one and
    // missing from the other. Anything that cannot be read is closed, not open.
    const settings = workerSettings(env as unknown as Record<string, unknown>, process.env);
    const gate = accessGateFromEnv(settings, () => supabaseMemberStores(getSupabaseClient()!));
    const app = createApiApp(
      deps,
      {
        kick: async (jobId, force) => {
          await env.LOOKUP_QUEUE.send({ jobId, force });
        },
      },
      gate,
    );
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const server = app.listen(PORT, () => {
        started = true;
        resolve();
      });
      server.on('error', (err) => {
        serverPromise = null;
        try { server.close(); } catch {}
        if (!started) reject(err);
        else console.error('Server runtime error:', err);
      });
    });
  })().catch((err) => {
    serverPromise = null;
    throw err;
  });
  return serverPromise;
}

export default {
  async fetch(request, env, ctx) {
    const settings = workerSettings(env as unknown as Record<string, unknown>, process.env);
    const access = accessConfigFromEnv(settings);
    const answered = await frontDoor(request, {
      store: () => getDeps(env).then((d) => d.store),
      access,
      emailPrefs: async () => {
        await getDeps(env);
        const db = getSupabaseClient();
        return db ? supabaseEmailPreferences(db) : null;
      },
      unsubscribeSecret: unsubscribeSecretFromEnv(settings),
    });
    if (answered) return answered;
    const path = new URL(request.url).pathname;
    if (path === '/demo') {
      // /demo is the app's page in sample mode (no server call on the page itself).
      // A signed-in visitor gets a mark on <html>; the banner then offers "Go to
      // your archive". The page differs by visitor, so it is never cached.
      const appPage = new Request(new URL('/app', request.url), request);
      if (!(await isSignedIn(request, access))) return env.ASSETS.fetch(appPage);
      const page = await env.ASSETS.fetch(appPage);
      const marked = new HTMLRewriter().on('html', {
        element: (el) => {
          el.setAttribute('data-signed-in', '');
        },
      }).transform(page);
      const headers = new Headers(marked.headers);
      headers.set('Cache-Control', 'private, no-store');
      headers.append('Vary', 'Cookie');
      return new Response(marked.body, { status: marked.status, headers });
    }
    if (path !== '/api' && !path.startsWith('/api/')) return env.ASSETS.fetch(request);
    // Health answers even when startup fails: it says only that the server is up.
    if (path === '/api/health' && request.method === 'GET') return Response.json(healthStatus());
    try {
      await ensureServer(env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Startup failed:', message);
      return Response.json({ error: `Server is not configured: ${message}` }, { status: 503 });
    }
    return handleAsNodeRequest(PORT, request, env, ctx);
  },

  async scheduled(_controller, env) {
    const deps = await getDeps(env);
    // Once, after 0014: point events saved before it at their records. Not with
    // multi-user on: each member's saves link into their own records, and this
    // global pass would link everyone's events into the old shared tables.
    try {
      if (!multiUserFromEnv(workerSettings(env as unknown as Record<string, unknown>, process.env))) {
        const done = await backfillEntities(deps.store);
        if (done) console.log(`Entity backfill: ${done.events} events, ${done.entities} records, ${done.aliases} aliases.`);
        // The next minute: venues whose events share one city are put in it.
        else {
          const venues = await backfillVenuePlaces(deps.store);
          if (venues) console.log(`Venue places: ${venues.venues} venues, ${venues.events} events.`);
        }
      }
    } catch (err) {
      console.error('Entity backfill failed:', err instanceof Error ? err.message : String(err));
    }
    // Once a day, at 03:00 UTC: erase trash past 90 days and Log rows past a year.
    const now = deps.now();
    if (isRetentionTime(now)) {
      try {
        const purged = await runRetention(deps.store, now);
        console.log(`Retention: ${purged.events} deleted shows, ${purged.activity} log rows erased.`);
      } catch (err) {
        console.error('Retention failed:', err instanceof Error ? err.message : String(err));
      }
    }
    // Once a day, at 16:00 UTC (8:00 AM PST): send at most 1 digest email of new access requests to the owner.
    const settings = workerSettings(env as unknown as Record<string, unknown>, process.env);
    if (isDigestTime(now) && multiUserFromEnv(settings)) {
      try {
        const db = getSupabaseClient();
        if (db) {
          const stores = supabaseMemberStores(db);
          const notifier = createEmailNotifier({
            sender: resendFromEnv(settings),
            prefs: stores,
            requests: stores,
            ownerEmail: settings.OWNER_EMAIL ?? null,
            secret: unsubscribeSecretFromEnv(settings),
            now: () => now,
          });
          const digest = await notifier.runDigest(now);
          if (digest.sent) console.log(`Request digest: sent (${digest.count} new requests).`);
        }
      } catch (err) {
        console.error('Request digest failed:', err instanceof Error ? err.message : String(err));
      }
    }
    const due = await deps.store.dueJobs(deps.now(), 5);
    if (due.length) await env.LOOKUP_QUEUE.sendBatch(due.map((job) => ({ body: { jobId: job.id } })));
  },

  // max_concurrency 1 and max_batch_size 1 keep jobs one at a time, which the
  // per-host rate limiter in http.ts relies on.
  async queue(batch, env) {
    const deps = await getDeps(env);
    for (const message of batch.messages) {
      const { jobId, force } = message.body;
      try {
        // One stage (or one page) per message: a whole lookup in one
        // invocation went past the 50-subrequest limit and was left "running".
        const job = await runJob(deps, jobId, { force, oneStep: true });
        if (job?.status === 'queued' && !job.nextAttemptAt) await env.LOOKUP_QUEUE.send({ jobId, force });
        message.ack();
      } catch (err) {
        const messageText = redactSecrets(err instanceof Error ? err.message : String(err));
        console.error(`Queue job ${jobId} unhandled failure (attempt ${message.attempts}):`, messageText);
        try {
          const current = await deps.store.getJob(jobId);
          if (current && current.status === 'running') {
            // attempts starts at 1; with max_retries = 3, attempt >= 4 is the final delivery attempt
            if (message.attempts >= 4) {
              await deps.store.updateJob({
                ...current,
                status: 'failed',
                lastError: `Queue delivery failed after ${message.attempts} attempts: ${messageText}`,
                updatedAt: deps.now().toISOString(),
              });
            } else {
              await deps.store.updateJob({
                ...current,
                status: 'queued',
                nextAttemptAt: new Date(deps.now().getTime() + 60_000).toISOString(),
                updatedAt: deps.now().toISOString(),
              });
            }
          }
        } catch (storeErr) {
          console.error(`Failed to update job ${jobId} state after queue error:`, storeErr);
        }
        // Retry with backoff. Once max_retries (3) is exceeded, Cloudflare Queues automatically
        // routes the message to the configured dead-letter queue (concert-tracker-lookups-dlq).
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, LookupMessage>;
