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

// The /api routes, shared by the Node server (server.ts) and the Cloudflare
// Worker (worker/index.ts). Static files and the job runner are wired by each host.
export function createApiApp(lineupDeps: PipelineDeps, runner: JobRunner): express.Express {
  const app = express();
  // Ticket emails arrive in batches with their HTML, larger than other requests.
  app.use('/api/imports/email', express.json({ limit: '25mb' }));
  // A music-story export lists every artist you have listened to.
  app.use('/api/artist-genres/music-story', express.json({ limit: '25mb' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Your event log: capture and details (stage 1), then lineup lookups (stage 2).
  app.use('/api', eventsRouter(lineupDeps, runner));
  // Genres of the acts you saw: the music-story file, then MusicBrainz on request.
  app.use('/api', genresRouter(lineupDeps));
  // Google Sheets sync for the Table view. Before the imports router: it
  // shares the Google sign-in callback with Connect Gmail.
  app.use('/api', sheetsRouter(lineupDeps, sheetsFromEnv()));
  // Stage 1 from email: ticket emails become a review list (see ARCHITECTURE.md).
  app.use('/api', importsRouter(lineupDeps, gmailFromEnv()));
  // Lineup lookup jobs and review (see ARCHITECTURE.md)
  app.use('/api', lineupRouter(lineupDeps, runner));

  return app;
}
