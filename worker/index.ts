import { handleAsNodeRequest } from 'cloudflare:node';
import { createApiApp } from '../src/server/app';
import { PipelineDeps, runJob } from '../src/server/lineup/pipeline';
import { createDeps, createStore } from '../src/server/lineup/service';

// Cloudflare Worker entry. Static files are served from ./dist by Workers
// static assets (wrangler.jsonc); only /api/* reaches this code.
//
// There is no long-lived process, so the Node LookupWorker is replaced by:
// - a Queue: "start" and "try now" send the job id, and the consumer runs it;
// - a Cron Trigger: every minute, jobs that are due (queued or past their
//   quota pause) are sent to the queue. Duplicate messages are harmless
//   because runJob skips a job that is no longer queued or waiting.

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
  const app = createApiApp(deps, {
    kick: async (jobId, force) => {
      await env.LOOKUP_QUEUE.send({ jobId, force });
    },
  });
  app.listen(PORT);
  listening = true;
}

export default {
  async fetch(request, env, ctx) {
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
    const due = await deps.store.dueJobs(deps.now(), 5);
    if (due.length) await env.LOOKUP_QUEUE.sendBatch(due.map((job) => ({ body: { jobId: job.id } })));
  },

  // max_concurrency 1 and max_batch_size 1 keep jobs one at a time, which the
  // per-host rate limiter in http.ts relies on.
  async queue(batch, _env) {
    const deps = await getDeps();
    for (const message of batch.messages) {
      await runJob(deps, message.body.jobId, { force: message.body.force });
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, LookupMessage>;
