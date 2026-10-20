import express from 'express';
import { PipelineDeps } from './lineup/pipeline';
import { JobRunner } from './lineup/service';
import { lineupRouter } from './lineup/routes';
import { eventsRouter } from './events/routes';
import { importsRouter } from './events/importRoutes';

// The /api routes, shared by the Node server (server.ts) and the Cloudflare
// Worker (worker/index.ts). Static files and the job runner are wired by each host.
export function createApiApp(lineupDeps: PipelineDeps, runner: JobRunner): express.Express {
  const app = express();
  // Ticket emails arrive in batches with their HTML, larger than other requests.
  app.use('/api/imports/email', express.json({ limit: '25mb' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Your event log: capture and details (stage 1), then lineup lookups (stage 2).
  app.use('/api', eventsRouter(lineupDeps, runner));
  // Stage 1 from email: ticket emails become a review list (see ARCHITECTURE.md).
  app.use('/api', importsRouter(lineupDeps));
  // Lineup lookup jobs and review (see ARCHITECTURE.md)
  app.use('/api', lineupRouter(lineupDeps, runner));

  return app;
}
