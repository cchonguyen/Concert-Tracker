import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

import { createDeps, createStore, LookupWorker } from './src/server/lineup/service';
import { createApiApp } from './src/server/app';
import { backfillEntities, backfillVenuePlaces } from './src/server/entities/linkingStore';

async function main() {
  const lineupStore = await createStore();
  await backfillEntities(lineupStore)
    .then(() => backfillVenuePlaces(lineupStore))
    .catch((err) => console.warn('Entity backfill failed:', err instanceof Error ? err.message : err));
  const lineupDeps = createDeps(lineupStore);
  const worker = new LookupWorker(lineupDeps);
  const app = createApiApp(lineupDeps, worker);
  worker.start();
  console.log(`Lineup store: ${lineupStore.kind}; Gemini: ${lineupDeps.gemini ? lineupDeps.gemini.model : 'not configured'}`);

  // Mount Vite or static server
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('/{*splat}', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
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
