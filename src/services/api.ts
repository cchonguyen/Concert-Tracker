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

export interface SupabaseClientValidation {
  configured: boolean;
  url: string | null;
  projectRef: string | null;
  dashboardSqlUrl: string | null;
  reachable: boolean;
  authenticated: boolean;
  httpStatus: number | null;
  latencyMs: number;
  tables: {
    venues: boolean;
    artists: boolean;
    events: boolean;
    event_appearances: boolean;
  };
  allTablesExist: boolean;
  readWriteVerified: boolean;
  message: string;
  diagnostics: string[];
}

export async function checkSupabaseStatus(): Promise<SupabaseClientValidation> {
  try {
    const res = await fetch('/api/supabase/status');
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    return await res.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Status request failed';
    return {
      configured: false,
      url: null,
      projectRef: null,
      dashboardSqlUrl: null,
      reachable: false,
      authenticated: false,
      httpStatus: null,
      latencyMs: 0,
      tables: { venues: false, artists: false, events: false, event_appearances: false },
      allTablesExist: false,
      readWriteVerified: false,
      message: `Failed to check Supabase status: ${msg}`,
      diagnostics: [msg],
    };
  }
}

export async function validateSupabaseConnection(): Promise<SupabaseClientValidation> {
  try {
    const res = await fetch('/api/supabase/validate', {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    return await res.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Validation request failed';
    return {
      configured: false,
      url: null,
      projectRef: null,
      dashboardSqlUrl: null,
      reachable: false,
      authenticated: false,
      httpStatus: null,
      latencyMs: 0,
      tables: { venues: false, artists: false, events: false, event_appearances: false },
      allTablesExist: false,
      readWriteVerified: false,
      message: `Validation probe failed: ${msg}`,
      diagnostics: [msg],
    };
  }
}

export async function syncToSupabase(payload: {
  venues: any[];
  artists: any[];
  events: any[];
  appearances: any[];
}): Promise<{ success: boolean; message?: string; syncedCounts?: any }> {
  try {
    const res = await fetch('/api/supabase/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        success: false,
        message: data?.error || data?.message || `HTTP server error ${res.status}`,
      };
    }
    return {
      success: true,
      message: data?.message || 'Sync completed successfully',
      syncedCounts: data?.syncedCounts,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Sync network error';
    return { success: false, message: msg };
  }
}

export async function fetchSupabaseArchive(): Promise<{ success: boolean; events: PopulatedEvent[]; error?: string }> {
  try {
    const res = await fetch('/api/supabase/events');
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        success: false,
        events: [],
        error: data?.error || `HTTP error ${res.status}`,
      };
    }
    return {
      success: true,
      events: data?.events || [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Network fetch error';
    return { success: false, events: [], error: msg };
  }
}

