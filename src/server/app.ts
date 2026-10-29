import express from 'express';
import { PipelineDeps } from './lineup/pipeline';
import { JobRunner } from './lineup/service';
import { lineupRouter } from './lineup/routes';
import { eventsRouter } from './events/routes';
import { importsRouter } from './events/importRoutes';
import { gmailFromEnv } from './events/email/gmail';
import { sheetsRouter } from './events/sheetRoutes';
import { sheetsFromEnv } from './events/sheets';
import { genresRouter } from './events/genreRoutes';
import { entitiesRouter } from './entities/routes';
import { shareRouter } from './share/routes';
import type { MultiUserConfig } from './auth/config';
import type { MemberDirectory } from './auth/members';
import { memberMiddleware, requestScopedStore } from './auth/requestScope';
import { accountRouter, membersRouter, singleOwnerMeRouter } from './auth/routes';
import { vaultGuard, vaultRouter } from './auth/vault';
import { peopleRouter } from './entities/people';

// The /api routes, shared by the Node server (server.ts) and the Cloudflare
// Worker (worker/index.ts). Static files and the job runner are wired by each host.
// multiUser: when set (MULTI_USER=on), every /api request after /api/health
// needs an invited member, and the routes see only that member's rows.
export function createApiApp(
  baseDeps: PipelineDeps,
  runner: JobRunner,
  multiUser?: { config: MultiUserConfig; directory: MemberDirectory },
): express.Express {
  const app = express();
  const lineupDeps: PipelineDeps = multiUser ? { ...baseDeps, store: requestScopedStore(baseDeps.store) } : baseDeps;
  // Ticket emails arrive in batches with their HTML, larger than other requests.
  app.use('/api/imports/email', express.json({ limit: '25mb' }));
  // A full re-scan's proposals (quotes only, no mail bodies).
  app.use('/api/imports/proposals', express.json({ limit: '10mb' }));
  // A music-story export lists every artist you have listened to.
  app.use('/api/artist-genres/music-story', express.json({ limit: '25mb' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  if (multiUser) {
    app.use('/api', memberMiddleware({ ...multiUser, base: baseDeps.store }));
    app.use('/api', membersRouter(multiUser.directory, lineupDeps.store));
    // Your data: the vault's key material, a plaintext-note guard, export and deletion.
    app.use('/api', vaultGuard(lineupDeps.store));
    app.use('/api', vaultRouter(lineupDeps.store));
    app.use('/api', peopleRouter(lineupDeps.store));
    app.use('/api', accountRouter(multiUser.directory, lineupDeps.store));
  } else {
    app.use('/api', singleOwnerMeRouter());
  }

  // Your event log: capture and details (stage 1), then lineup lookups (stage 2).
  app.use('/api', eventsRouter(lineupDeps, runner));
  // Genres of the acts you saw: the music-story file, then MusicBrainz on request.
  app.use('/api', genresRouter(lineupDeps));
  // Google Sheets sync for the Table view. Before the imports router: it
  // shares the Google sign-in callback with Connect Gmail.
  app.use('/api', sheetsRouter(lineupDeps, sheetsFromEnv()));
  // Stage 1 from email: ticket emails become a review list (see ARCHITECTURE.md).
  app.use('/api', importsRouter(lineupDeps, gmailFromEnv()));
  // The records behind your events' names (src/server/entities/).
  app.use('/api', entitiesRouter(lineupDeps));
  // The owner's controls for the share page (src/server/share/).
  app.use('/api', shareRouter(lineupDeps));
  // Lineup lookup jobs and review (see ARCHITECTURE.md)
  app.use('/api', lineupRouter(lineupDeps, runner));

  return app;
}
