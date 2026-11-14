import { handleAsNodeRequest } from 'cloudflare:node';
import { settledOnce } from '../src/server/settledOnce';
import { createApiApp, healthStatus } from '../src/server/app';
import { PipelineDeps, isRequeueTime, requeueFailedResolveArtists, runJob } from '../src/server/lineup/pipeline';
import { createDeps, createStore } from '../src/server/lineup/service';
import { startTrace } from '../src/server/telemetry/trace';
import { runCanonBackfill } from '../src/server/canon/backfill';
import { backfillEntities, backfillVenuePlaces } from '../src/server/entities/linkingStore';
import { frontDoor, isSignedIn } from '../src/server/share/door';
import { accessConfigFromEnv } from '../src/server/share/access';
import { isRetentionTime, runRetention } from '../src/server/events/retention';
import { accessGateFromEnv, multiUserFromEnv, workerSettings } from '../src/server/auth/config';
import { supabaseMemberDirectory, supabaseMemberStores } from '../src/server/auth/members';
import { MEMBER_BACKFILL_OVERRIDE_SETTING, overrideActive, runMemberBackfill } from '../src/server/canon/memberBackfill';
import { getSupabaseClient } from '../src/server/supabase';
import { createEmailNotifier, isDigestTime } from '../src/server/email/notifier';
import { resendFromEnv } from '../src/server/email/sender';
import { supabaseEmailPreferences } from '../src/server/email/store';
import { unsubscribeSecretFromEnv } from '../src/server/email/unsubscribe';
import { redactSecrets } from '../src/server/lineup/http';
import type { EventsRunner } from '../src/server/events/routes';
import { defaultFinders, researchCatalogFor, runQueuedResearch } from '../src/server/events/details';
import { runResearchBackfill } from '../src/server/events/backfillResearch';
import { rung4Urls, runReaderPage } from '../src/server/events/detailsGemini';
import { currentBudget, makeBudget, runWithBudget } from '../src/server/lineup/budget';

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

// type is absent on messages queued before Slice 11.15: they are lookups.
type LookupMessage =
  | { type?: 'lookup'; jobId: string; force?: boolean }
  | { type: 'research'; eventId: string; userId?: string; role?: 'owner' | 'member' }
  // Slice 11.17, rung 4: the reader reads ONE page for the event, after rung 1 to 3 research.
  | { type: 'research_reader'; eventId: string; url: string; userId?: string; role?: 'owner' | 'member' };

interface Env {
  LOOKUP_QUEUE?: Queue<LookupMessage>;
  ASSETS: Fetcher;
}

const PORT = 8080;

// Built once per isolate. process.env is populated from vars and secrets by
// nodejs_compat. A failed start is retried on the next request. With
// multi-user on, a job whose member is blocked or removed is parked (runJob).
// Only finished values are shared between requests (settledOnce), never a
// promise another request is still running.
const depsOnce = settledOnce(async (env: Env): Promise<PipelineDeps> => {
  const deps = await createDeps(await createStore({ requireSupabase: true }));
  const settings = workerSettings(env as unknown as Record<string, unknown>, process.env);
  if (settings.MULTI_USER?.trim().toLowerCase() !== 'on') return deps;
  const members = supabaseMemberStores(getSupabaseClient()!);
  return { ...deps, hasActiveUser: (userId: string) => members.hasActiveUser(userId) };
});
const getDeps = (env: Env): Promise<PipelineDeps> => depsOnce.get(env);

const serverOnce = settledOnce(async (env: Env): Promise<void> => {
    const deps = await getDeps(env);
    // Who may use /api (src/server/auth/config.ts). Read from the bindings as
    // well as the process environment, so MULTI_USER cannot be on in one and
    // missing from the other. Anything that cannot be read is closed, not open.
    const settings = workerSettings(env as unknown as Record<string, unknown>, process.env);
    const gate = accessGateFromEnv(settings, () => supabaseMemberStores(getSupabaseClient()!));
    const runner: EventsRunner = {
      kick: async (jobId, force) => {
        await env.LOOKUP_QUEUE?.send({ jobId, force });
      },
      // Slice 11.15: stage 1 research for a saved event runs from the queue (rungs 1 to 3, no reader model).
      kickResearch: async (eventId, actor) => {
        await env.LOOKUP_QUEUE?.send({ type: 'research', eventId, userId: actor?.userId, role: actor?.role });
      },
    };
    const app = createApiApp(deps, runner, gate);
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const server = app.listen(PORT, () => {
        started = true;
        resolve();
      });
      server.on('error', (err) => {
        serverOnce.reset();
        try { server.close(); } catch {}
        if (!started) reject(err);
        else console.error('Server runtime error:', err);
      });
    });
});
const ensureServer = (env: Env): Promise<void> => serverOnce.get(env);

// The Cron Trigger's work (scheduled below), run inside one subrequest budget.
async function runCron(env: Env): Promise<void> {
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
  // Hourly: put artist-resolution jobs that failed on a MusicBrainz 503 back to waiting. Idempotent (log marker).
  if (isRequeueTime(now)) {
    try {
      const ids = await requeueFailedResolveArtists(deps);
      if (ids.length) console.log(`Re-queued ${ids.length} artist-resolution job(s) that failed on a MusicBrainz 503.`);
    } catch (err) {
      console.error('Artist-resolution re-queue failed:', err instanceof Error ? err.message : String(err));
    }
  }
  // Runs before the owner backfill (Slice 12.14): that backfill spends the whole subrequest budget every minute, so a
  // member backfill placed after it never got a call through.
  // Slice 12.6: backfill provisional shared editions from members' existing dated events (accepted notice v2 only),
  // a few per run, cursor per member in that member's settings. Multi-user only; counts are all that is logged.
  try {
    // Every fifth minute: a finished member still costs two settings reads, so the idle cost stays low.
    const db = multiUserFromEnv(settings) && now.getUTCMinutes() % 5 === 0 ? getSupabaseClient() : null;
    if (db) {
      const members = await supabaseMemberDirectory(db).listMembers();
      const trace = startTrace('backfill');
      const overrideValue = await deps.store.getSetting<{ until?: string }>(MEMBER_BACKFILL_OVERRIDE_SETTING);
      const anyNotice = overrideActive(overrideValue, now);
      const report = await runMemberBackfill(deps.store, members, { anyNotice });
      const b = currentBudget();
      if (report) {
        console.log(`Member backfill (notice override ${anyNotice ? 'on' : 'off'}): ${JSON.stringify(report)}`);
        trace.step('member_backfill', { ...report });
        await trace.finish(deps.store); // +1 subrequest, only when the run did something
      } else if (anyNotice) {
        // Slice 12.12: while the override is on, a run that did nothing still leaves counts (no ids) so the cause shows.
        const walkable = members.filter((m) => m.role !== 'owner' && !m.blocked && m.userId).length;
        const detail = { listed: members.length, walkable, budgetUsed: b?.used ?? -1, budgetLimit: b?.limit ?? -1 };
        console.log(`Member backfill idle: ${JSON.stringify(detail)}`);
        trace.step('member_backfill_idle', detail);
        await trace.finish(deps.store);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Member backfill failed:', message);
    try {
      // Slice 12.12: leave the error text (no ids; store errors name tables, not people) where it can be read.
      const t = startTrace('backfill');
      t.step('member_backfill_error', { message: message.slice(0, 200) } as any);
      await t.finish(deps.store);
    } catch {
      // Best effort: the budget may be spent.
    }
  }
  // Slice 11.14: backfill shared editions from the owner's events and email imports, up to 20 a run (fewer when
  // the subrequest budget is short). Owner only: with multi-user on it reads the owner's scoped store.
  // Throttled to every 5 minutes to keep idle cost low.
  if (now.getUTCMinutes() % 5 === 0) {
    try {
      let store: typeof deps.store | null = deps.store;
      if (multiUserFromEnv(settings)) {
        const ownerId = await deps.store.ownerUserId?.();
        store = ownerId && deps.store.forUser ? deps.store.forUser({ userId: ownerId, role: 'owner' }) : null;
      }
      const trace = startTrace('backfill');
      const backfill = store ? await runCanonBackfill(store) : null;
      if (backfill) {
        console.log(`Canon backfill: ${JSON.stringify(backfill)}`);
        if (backfill.created > 0 || backfill.matched > 0 || backfill.venue_set > 0 || backfill.subject_set > 0) {
          trace.step('canon_backfill', Object.fromEntries(Object.entries(backfill).filter(([, v]) => typeof v === 'number')));
          await trace.finish(deps.store); // +1 subrequest, only when the run did something
        }
      }
    } catch (err) {
      console.error('Canon backfill failed:', err instanceof Error ? err.message : String(err));
    }
  }
  // Slice 11.19: research up to 5 events still 'pending' (rungs 1 and 2, no Brave, no reader), owner only, as many
  // as the subrequest budget allows (worst case 3 + 5 * 25 = 128; backfillResearch.ts).
  try {
    let store: typeof deps.store | null = deps.store;
    let ownerId: string | undefined;
    if (multiUserFromEnv(settings)) {
      ownerId = (await deps.store.ownerUserId?.()) ?? undefined;
      store = ownerId && deps.store.forUser ? deps.store.forUser({ userId: ownerId, role: 'owner' }) : null;
    }
    const researched = store
      ? await runResearchBackfill(store, defaultFinders(), deps.fetcher, now, { role: ownerId ? 'owner' : undefined, userId: ownerId, catalogStore: deps.store })
      : null;
    if (researched?.researched) {
      console.log(`Research backfill: ${JSON.stringify(researched)}`);
      const trace = startTrace('research_backfill');
      trace.step('research_backfill', { researched: researched.researched });
      await trace.finish(deps.store); // +1 subrequest, only when the run researched something
    }
  } catch (err) {
    console.error('Research backfill failed:', redactSecrets(err instanceof Error ? err.message : String(err)));
  }
  const due = await deps.store.dueJobs(deps.now(), 5);
  if (due.length) await env.LOOKUP_QUEUE?.sendBatch(due.map((job) => ({ body: { jobId: job.id } })));
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
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      console.error('Startup failed:', message);
      return Response.json({ error: `Server is not configured: ${message}` }, { status: 503 });
    }
    return handleAsNodeRequest(PORT, request, env, ctx);
  },

  async scheduled(_controller, env) {
    // One subrequest budget for the whole cron run (src/server/lineup/budget.ts).
    await runWithBudget(makeBudget(), () => runCron(env));
  },

  // max_concurrency 1 and max_batch_size 1 keep jobs one at a time, which the
  // per-host rate limiter in http.ts relies on.
  async queue(batch, env) {
    const deps = await getDeps(env);
    for (const message of batch.messages) {
      if (message.body.type === 'research') {
        const { eventId, userId, role } = message.body;
        // One research message: at most 27 subrequests (13 + catalog rungs 1 and 2; 1 over the plan's 26; details.ts, runQueuedResearch), in its own budget.
        const budget = makeBudget();
        await runWithBudget(budget, async () => {
          const trace = startTrace('research', { eventId });
          try {
            const store = userId && deps.store.forUser ? deps.store.forUser({ userId, role: role ?? 'member' }) : deps.store;
            const done = await runQueuedResearch(store, eventId, defaultFinders(), deps.fetcher, deps.now(), researchCatalogFor(role, userId, deps.store));
            // Rung 4: only with the reader set up, a full date and a gap left; at most 2 pages, one message each (+2 sends).
            trace.step('research_done', { ran: !!done });
            if (done && deps.reader) {
              const urls = rung4Urls(done);
              trace.step('rung4_queued', { pages: urls.length });
              for (const url of urls) await env.LOOKUP_QUEUE?.send({ type: 'research_reader', eventId, url, userId, role });
            }
          } catch (err) {
            trace.step('research_failed');
            // The event stays as typed and 'pending'; "Look again" can run it. No retry, no fallback.
            console.error(`Queue research ${eventId} failed:`, redactSecrets(err instanceof Error ? err.message : String(err)));
          }
          trace.subrequests(budget.used);
          await trace.finish(deps.store); // +1 subrequest (one trace row per message)
          message.ack();
        });
        continue;
      }
      if (message.body.type === 'research_reader') {
        const { eventId, url, userId, role } = message.body;
        // One page per message. Worst case: getEvent 1 + page fetch 1 + one guarded model call (guard and ledger
        // store calls, ai_calls row, the model itself; about 8) + putEvent 1 = about 11 of 50. No retry, no fallback.
        const budget = makeBudget();
        await runWithBudget(budget, async () => {
          const trace = startTrace('research_reader', { eventId });
          try {
            if (deps.reader) {
              const store = userId && deps.store.forUser ? deps.store.forUser({ userId, role: role ?? 'member' }) : deps.store;
              await runReaderPage(store, deps.reader, eventId, url, deps.fetcher, deps.now());
              trace.step('reader_page_done');
            }
          } catch (err) {
            trace.step('reader_failed');
            console.error(`Queue reader ${eventId} failed:`, redactSecrets(err instanceof Error ? err.message : String(err)));
          }
          trace.subrequests(budget.used);
          await trace.finish(deps.store); // +1 subrequest (one trace row per message)
          message.ack();
        });
        continue;
      }
      const { jobId, force } = message.body;
      // Each message has its own subrequest budget (src/server/lineup/budget.ts).
      const budget = makeBudget();
      await runWithBudget(budget, async () => {
        try {
          // One stage (or one page) per message: a whole lookup in one
          // invocation went past the 50-subrequest limit and was left "running".
          const job = await runJob(deps, jobId, { force, oneStep: true });
          if (job?.status === 'queued' && !job.nextAttemptAt) await env.LOOKUP_QUEUE?.send({ jobId, force });
          const trace = startTrace('lookup', { jobId, eventId: job?.eventId });
          trace.step('lookup_step', { status: job?.status ?? 'missing' });
          trace.subrequests(budget.used);
          await trace.finish(deps.store); // +1 subrequest (one trace row per message)
          message.ack();
        } catch (err) {
          const messageText = redactSecrets(err instanceof Error ? err.message : String(err));
          console.error(`Queue job ${jobId} unhandled failure (attempt ${message.attempts}):`, messageText);
          try {
            // The error path may use the budget's reserve, so the job's state can still be saved.
            budget.take(1, { reserved: true });
            const current = await deps.store.getJob(jobId);
            if (current && current.status === 'running') {
              // attempts starts at 1; with max_retries = 3, attempt >= 4 is the final delivery attempt
              if (message.attempts >= 4) {
                budget.take(1, { reserved: true });
                await deps.store.updateJob({
                  ...current,
                  status: 'failed',
                  lastError: `Queue delivery failed after ${message.attempts} attempts: ${messageText}`,
                  updatedAt: deps.now().toISOString(),
                });
              } else {
                budget.take(1, { reserved: true });
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
      });
    }
  },
} satisfies ExportedHandler<Env, LookupMessage>;
