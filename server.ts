import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

import { extractEventDetails, scanInputCues } from './src/server/geminiExtractionEngine';
import { validateSupabase, syncEventsToSupabase, fetchEventsFromSupabase } from './src/server/supabase';

async function main() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // POST /api/scan-cues - Real-time cue detection & scanner guidance
  app.post('/api/scan-cues', (req, res) => {
    try {
      const cues = scanInputCues(req.body);
      res.json({ cues });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Cue scan failure';
      res.status(400).json({ error: msg });
    }
  });

  // POST /api/extract-event - Dedicated Gemini Extraction Engine endpoint
  app.post('/api/extract-event', async (req, res) => {
    try {
      const { concertName, dateHint, endDateHint, attendedDaysHint, venueHint, cityHint, tourHint, notesHint } = req.body;

      if (!concertName || typeof concertName !== 'string' || !concertName.trim()) {
        res.status(400).json({ error: 'Concert query or headliner is required for extraction.' });
        return;
      }

      const result = await extractEventDetails({
        concertName,
        dateHint,
        endDateHint,
        attendedDaysHint,
        venueHint,
        cityHint,
        tourHint,
        notesHint,
      });

      res.json({
        manifest: result.manifest,
        transformed: result.transformed,
        metadata: result.metadata,
        modelUsed: result.metadata.extractionModel,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown extraction failure';
      res.status(500).json({ error: errorMessage });
    }
  });

  // POST /api/enrich - Backwards-compatible alias for extraction
  app.post('/api/enrich', async (req, res) => {
    try {
      const { concertName, dateHint, endDateHint, attendedDaysHint, venueHint, cityHint, tourHint, notesHint } = req.body;

      if (!concertName || typeof concertName !== 'string' || !concertName.trim()) {
        res.status(400).json({ error: 'Concert query or headliner is required for extraction.' });
        return;
      }

      const result = await extractEventDetails({
        concertName,
        dateHint,
        endDateHint,
        attendedDaysHint,
        venueHint,
        cityHint,
        tourHint,
        notesHint,
      });

      res.json({
        manifest: result.manifest,
        transformed: result.transformed,
        metadata: result.metadata,
        modelUsed: result.metadata.extractionModel,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown extraction failure';
      res.status(500).json({ error: errorMessage });
    }
  });

  // GET /api/musicbrainz/lookup - Canonical MusicBrainz Resolution
  app.get('/api/musicbrainz/lookup', async (req, res) => {
    try {
      const query = (req.query.query as string) || '';
      if (!query.trim()) {
        res.json({ artists: [] });
        return;
      }

      const mbUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json`;

      const response = await fetch(mbUrl, {
        headers: {
          'User-Agent': 'LiveArchiveConcertTracker/1.0.0 ( contact@example.com )',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        console.warn('MusicBrainz API error status:', response.status);
        res.json({ artists: [] });
        return;
      }

      const data = await response.json();
      const artists = (data.artists || []).slice(0, 6).map((art: any) => ({
        id: art.id,
        name: art.name,
        country: art.country || art.area?.name,
        disambiguation: art.disambiguation,
        tags: (art.tags || []).slice(0, 4).map((t: any) => t.name),
        score: art.score,
      }));

      res.json({ artists });
    } catch (err: unknown) {
      console.warn('MusicBrainz lookup failed:', err);
      res.json({ artists: [] });
    }
  });

  // POST /api/sheets-sync - Downstream Google Sheets replica webhook dispatcher
  app.post('/api/sheets-sync', async (req, res) => {
    try {
      const { event, webhookUrl } = req.body;
      if (!event) {
        res.status(400).json({ error: 'Event object is required for sync.' });
        return;
      }

      const allArtists = (event.appearances || [])
        .map((a: any) => a.artist?.name)
        .filter(Boolean)
        .join('; ');

      const formattedPayload = {
        event_id: event.id,
        event_name: event.name,
        tour_name: event.tour_name || 'N/A',
        event_date: event.event_date,
        venue: event.venue?.name || 'N/A',
        city: event.venue?.city || 'N/A',
        artists: allArtists,
        ticket_price: event.ticket_price || 0,
        synced_at: new Date().toISOString(),
      };

      if (webhookUrl && typeof webhookUrl === 'string' && webhookUrl.startsWith('http')) {
        try {
          const syncRes = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formattedPayload),
          });
          res.json({
            success: true,
            status: syncRes.status,
            message: `Dispatched to Google Sheets Webhook with HTTP ${syncRes.status}`,
            payload: formattedPayload,
          });
          return;
        } catch (dispatchErr: any) {
          res.json({
            success: false,
            message: `Webhook dispatch failed: ${dispatchErr.message}`,
            payload: formattedPayload,
          });
          return;
        }
      }

      // Simulated edge function sync execution
      res.json({
        success: true,
        message: 'Successfully serialized and prepared for Google Sheets Downstream Replica',
        payload: formattedPayload,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown sync failure';
      res.status(500).json({ error: errorMessage });
    }
  });

  // GET /api/supabase/status - Supabase connectivity & schema check
  app.get('/api/supabase/status', async (req, res) => {
    try {
      const result = await validateSupabase();
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Validation failed';
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/supabase/validate - Trigger live full diagnostic probe
  app.post('/api/supabase/validate', async (req, res) => {
    try {
      const result = await validateSupabase();
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Validation failed';
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/supabase/sync - Upsert local entities into Supabase
  app.post('/api/supabase/sync', async (req, res) => {
    try {
      const { venues, artists, events, appearances } = req.body;
      const result = await syncEventsToSupabase({ venues, artists, events, appearances });
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/supabase/events - Query events from Supabase
  app.get('/api/supabase/events', async (req, res) => {
    try {
      const events = await fetchEventsFromSupabase();
      res.json({ events });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Fetch failed';
      res.status(500).json({ error: msg });
    }
  });

  // Mount Vite or static server
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
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
