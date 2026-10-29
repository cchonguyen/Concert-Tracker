import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

import { createDeps, createStore, LookupWorker } from './src/server/lineup/service';
import { accessGateFromEnv } from './src/server/auth/config';
import { supabaseMemberDirectory } from './src/server/auth/members';
import { getSupabaseClient } from './src/server/supabase';
import { createApiApp } from './src/server/app';
import { backfillEntities, backfillVenuePlaces } from './src/server/entities/linkingStore';
import { oldAppLink } from './src/server/site/publicPaths';

async function main() {
  const lineupStore = await createStore();
  await backfillEntities(lineupStore)
    .then(() => backfillVenuePlaces(lineupStore))
    .catch((err) => console.warn('Entity backfill failed:', err instanceof Error ? err.message : err));
  const lineupDeps = createDeps(lineupStore);
  const worker = new LookupWorker(lineupDeps);
  // Who may use /api (src/server/auth/config.ts). Nothing is open by default.
  const app = createApiApp(lineupDeps, worker, accessGateFromEnv(process.env, () => supabaseMemberDirectory(getSupabaseClient()!)));
  worker.start();
  console.log(`Lineup store: ${lineupStore.kind}; Gemini: ${lineupDeps.gemini ? lineupDeps.gemini.model : 'not configured'}`);

  // The same addresses as the Worker (src/server/share/door.ts): old app links
  // go to /app, and /app is the app's page (app.html). "/" is the marketing page.
  app.use((req, res, next) => {
    const moved = oldAppLink(new URL(req.originalUrl, 'http://localhost'));
    if (moved) return res.redirect(302, moved);
    if (req.path === '/app') req.url = `/app.html${req.url.slice('/app'.length)}`;
    next();
  });

  // Mount Vite or static server
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'mpa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.use((_req, res) => {
      res.status(404).sendFile(path.resolve(__dirname, 'dist', '404.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LiveArchive server is running at http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
