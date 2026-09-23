import { ExtractedEventManifest, PopulatedEvent, StagingInput } from '../types/schema';
import { executeEventExtraction, ExtractionEngineResult } from './extractionEngine';

export async function enrichConcertEvent(input: StagingInput): Promise<ExtractedEventManifest> {
  const result = await executeEventExtraction(input);
  return result.manifest;
}

export { executeEventExtraction };
export type { ExtractionEngineResult };

export interface MusicBrainzArtistResult {
  id: string;
  name: string;
  country?: string;
  disambiguation?: string;
  tags?: string[];
  score?: number;
}

export async function lookupMusicBrainz(artistName: string): Promise<MusicBrainzArtistResult[]> {
  try {
    const response = await fetch(
      `/api/musicbrainz/lookup?query=${encodeURIComponent(artistName)}`,
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.artists || [];
  } catch (err) {
    console.warn('MusicBrainz lookup failed:', err);
    return [];
  }
}

export async function dispatchSheetsSync(
  event: PopulatedEvent,
  customWebhookUrl?: string,
): Promise<{ success: boolean; message: string; payload?: unknown }> {
  try {
    const response = await fetch('/api/sheets-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event,
        webhookUrl: customWebhookUrl,
      }),
    });
    return await response.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown sync failure';
    return {
      success: false,
      message: msg,
    };
  }
}
