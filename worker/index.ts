import { handleAsNodeRequest } from 'cloudflare:node';
import { createApiApp } from '../src/server/app';
import { PipelineDeps, runJob } from '../src/server/lineup/pipeline';
import { createDeps, createStore } from '../src/server/lineup/service';
import { backfillEntities, backfillVenuePlaces } from '../src/server/entities/linkingStore';
import { frontDoor } from '../src/server/share/door';
import { accessConfigFromEnv } from '../src/server/share/access';
import { multiUserFromEnv, workerSettings } from '../src/server/auth/config';
import { supabaseMemberDirectory } from '../src/server/auth/members';
import { getSupabaseClient } from '../src/server/supabase';

// Cloudflare Worker entry. Static files are served from ./dist by Workers
// static assets (wrangler.jsonc); only /api/* and the share page (/s/*)
// reach this code. frontDoor runs first: it answers share page paths itself
// and, once ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, refuses any other
// request without a valid Cloudflare Access token.
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
}

const PORT = 8080;
let depsPromise: Promise<PipelineDeps> | null = null;
let listening = false;

// Built once per isolate. process.env is populated from vars and secrets by
// nodejs_compat. A failed start is retried on the next request.
function getDeps(): Promise<PipelineDeps> {
  depsPromise ??= createStore({ requireSupabase: true })
    .then(createDeps)
    .catch((err) => {
      depsPromise = null;
      throw err;
    });
  return depsPromise;
}

async function ensureServer(env: Env): Promise<void> {
  if (listening) return;
  const deps = await getDeps();
  if (listening) return;
  // MULTI_USER=on turns on members (src/server/auth/); off by default. Read from
  // the bindings as well as the process environment, so it cannot be on in one
  // and missing from the other (that would serve the owner's data to anyone
  // Access lets in).
  const settings = workerSettings(env as unknown as Record<string, unknown>, process.env);
  const config = multiUserFromEnv(settings);
  const multiUser = config ? { config, directory: supabaseMemberDirectory(getSupabaseClient()!) } : undefined;
  const app = createApiApp(
    deps,
    {
      kick: async (jobId, force) => {
        await env.LOOKUP_QUEUE.send({ jobId, force });
      },
    },
    multiUser,
  );
  app.listen(PORT);
  listening = true;
}

export default {
  async fetch(request, env, ctx) {
    const answered = await frontDoor(request, {
      store: () => getDeps().then((d) => d.store),
      access: accessConfigFromEnv(workerSettings(env as unknown as Record<string, unknown>, process.env)),
    });
    if (answered) return answered;
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
    const deps = await getDeps();
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
    const due = await deps.store.dueJobs(deps.now(), 5);
    if (due.length) await env.LOOKUP_QUEUE.sendBatch(due.map((job) => ({ body: { jobId: job.id } })));
  },

  // max_concurrency 1 and max_batch_size 1 keep jobs one at a time, which the
  // per-host rate limiter in http.ts relies on.
  async queue(batch, env) {
    const deps = await getDeps();
    for (const message of batch.messages) {
      const { jobId, force } = message.body;
      // One stage (or one page) per message: a whole lookup in one
      // invocation went past the 50-subrequest limit and was left "running".
      const job = await runJob(deps, jobId, { force, oneStep: true });
      if (job?.status === 'queued' && !job.nextAttemptAt) await env.LOOKUP_QUEUE.send({ jobId, force });
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, LookupMessage>;
