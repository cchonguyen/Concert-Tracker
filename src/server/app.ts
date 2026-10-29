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
import type { AccessGate } from './auth/config';
import { closedMiddleware, localOwnerMiddleware, ownerMiddleware } from './auth/gate';
import { memberMiddleware, requestScopedStore } from './auth/requestScope';
import { accountRouter, membersRouter, singleOwnerMeRouter } from './auth/routes';
import { accessRequestOwnerRouter, accessRequestRouter } from './auth/requestRoutes';
import { vaultGuard, vaultRouter } from './auth/vault';
import { peopleRouter } from './entities/people';

// The body of GET /api/health. It says only that the server is up, and it
// answers even when access is closed (config.ts).
export const healthStatus = () => ({ status: 'ok', timestamp: new Date().toISOString() });

// The /api routes, shared by the Node server (server.ts) and the Cloudflare
// Worker (worker/index.ts). Static files and the job runner are wired by each host.
// gate: who may use /api (config.ts). Every /api request after /api/health passes
// it: members (MULTI_USER=on), the owner (OWNER_EMAIL), or nobody (closed, 503).
export function createApiApp(baseDeps: PipelineDeps, runner: JobRunner, gate: AccessGate): express.Express {
  const app = express();
  const lineupDeps: PipelineDeps = gate.kind === 'multi' ? { ...baseDeps, store: requestScopedStore(baseDeps.store) } : baseDeps;
  // Ticket emails arrive in batches with their HTML, larger than other requests.
  app.use('/api/imports/email', express.json({ limit: '25mb' }));
  // A full re-scan's proposals (quotes only, no mail bodies).
  app.use('/api/imports/proposals', express.json({ limit: '10mb' }));
  // A music-story export lists every artist you have listened to.
  app.use('/api/artist-genres/music-story', express.json({ limit: '25mb' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json(healthStatus());
  });

  if (gate.kind === 'multi') {
    // Asking for access comes before the member check: a stranger may ask (requestRoutes.ts).
    app.use('/api', accessRequestRouter({ config: gate, directory: gate.directory, requests: gate.directory }));
    app.use('/api', memberMiddleware({ config: gate, directory: gate.directory, base: baseDeps.store }));
    app.use('/api', membersRouter(gate.directory, lineupDeps.store, gate.directory));
    app.use('/api', accessRequestOwnerRouter(gate.directory));
    // Your data: the vault's key material, a plaintext-note guard, export and deletion.
    app.use('/api', vaultGuard(lineupDeps.store));
    app.use('/api', vaultRouter(lineupDeps.store));
    app.use('/api', peopleRouter(lineupDeps.store));
    app.use('/api', accountRouter(gate.directory, lineupDeps.store));
  } else if (gate.kind === 'owner') {
    app.use('/api', ownerMiddleware(gate));
    app.use('/api', singleOwnerMeRouter());
  } else if (gate.kind === 'local') {
    app.use('/api', localOwnerMiddleware());
    app.use('/api', singleOwnerMeRouter());
  } else {
    app.use('/api', closedMiddleware(gate.reason));
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
