import express from 'express';
import { PipelineDeps } from './lineup/pipeline';
import { makeBudget, runWithBudget } from './lineup/budget';
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
import { prefsRouter } from './auth/prefs';
import { accessRequestOwnerRouter, accessRequestRouter } from './auth/requestRoutes';
import { vaultGuard, vaultRouter } from './auth/vault';
import { peopleRouter } from './entities/people';
import { createEmailNotifier, type EmailNotifier } from './email/notifier';
import { resendFromEnv } from './email/sender';
import { memoryEmailPreferences, type EmailPreferenceStore } from './email/store';
import { unsubscribeSecretFromEnv } from './email/unsubscribe';

// The body of GET /api/health. It says only that the server is up, and it
// answers even when access is closed (config.ts).
export const healthStatus = () => ({ status: 'ok', timestamp: new Date().toISOString() });

// The /api routes, shared by the Node server (server.ts) and the Cloudflare
// Worker (worker/index.ts). Static files and the job runner are wired by each host.
// gate: who may use /api (config.ts). Every /api request after /api/health passes
// it: members (MULTI_USER=on), the owner (OWNER_EMAIL), or nobody (closed, 503).
export function createApiApp(
  baseDeps: PipelineDeps,
  runner: JobRunner,
  gate: AccessGate,
  emailNotifier?: EmailNotifier,
): express.Express {
  const app = express();
  // Every /api request has its own subrequest budget (src/server/lineup/budget.ts).
  app.use('/api', (_req, _res, next) => {
    void runWithBudget(makeBudget(), async () => {
      next();
    });
  });
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

  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.originalUrl.split('?')[0] === '/api/imports/email') return next();
    const fetchSite = req.get('sec-fetch-site')?.trim().toLowerCase();
    if (fetchSite === 'cross-site') {
      return res.status(403).json({ error: 'Cross-origin request refused.' });
    }
    const origin = req.get('origin')?.trim();
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return res.status(403).json({ error: 'Cross-origin request refused.' });
      }
      if (originHost !== req.get('host')?.trim()) {
        return res.status(403).json({ error: 'Cross-origin request refused.' });
      }
    }
    next();
  });

  if (gate.kind === 'multi') {
    const prefs: EmailPreferenceStore =
      gate.directory.getEmailPreference && gate.directory.setEmailOptOut && gate.directory.markEmailSent
        ? (gate.directory as EmailPreferenceStore)
        : memoryEmailPreferences();
    const notifier =
      emailNotifier ??
      createEmailNotifier({
        sender: resendFromEnv(),
        prefs,
        requests: gate.directory,
        ownerEmail: process.env.OWNER_EMAIL ?? null,
        secret: unsubscribeSecretFromEnv({
          EMAIL_UNSUBSCRIBE_SECRET: process.env.EMAIL_UNSUBSCRIBE_SECRET,
          SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ?? gate.jwtSecret,
        }),
      });
    const directory = {
      ...gate.directory,
      onFirstJoin: async (email: string) => {
        await gate.directory.onFirstJoin?.(email);
        await notifier.sendWelcome(email);
      },
    };
    // Asking for access comes before the member check: a stranger may ask (requestRoutes.ts).
    app.use('/api', accessRequestRouter({ config: gate, directory, requests: gate.directory }));
    app.use('/api', memberMiddleware({ config: gate, directory, base: baseDeps.store }));
    app.use('/api', membersRouter(directory, lineupDeps.store, gate.directory, notifier));
    app.use('/api', accessRequestOwnerRouter(gate.directory, notifier));
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

  // Home tips and the milestone mark, per account (src/server/auth/prefs.ts).
  app.use('/api', prefsRouter(lineupDeps.store));

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
