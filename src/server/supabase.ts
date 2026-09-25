import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseValidationResult {
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

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return null;
  }

  if (!cachedClient) {
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return cachedClient;
}

export function extractProjectRef(urlStr: string | undefined): string | null {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    const hostParts = url.hostname.split('.');
    if (hostParts.length >= 3 && hostParts[1] === 'supabase' && hostParts[2] === 'co') {
      return hostParts[0];
    }
  } catch {
    // Ignore invalid url
  }
  return null;
}

export async function validateSupabase(): Promise<SupabaseValidationResult> {
  const url = process.env.SUPABASE_URL || null;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
  const projectRef = extractProjectRef(url || undefined);
  const dashboardSqlUrl = projectRef
    ? `https://supabase.com/dashboard/project/${projectRef}/sql/new`
    : null;

  const diagnostics: string[] = [];
  const tables = {
    venues: false,
    artists: false,
    events: false,
    event_appearances: false,
  };

  if (!url || !key) {
    return {
      configured: false,
      url,
      projectRef,
      dashboardSqlUrl,
      reachable: false,
      authenticated: false,
      httpStatus: null,
      latencyMs: 0,
      tables,
      allTablesExist: false,
      readWriteVerified: false,
      message: 'Supabase credentials (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are not configured in environment variables.',
      diagnostics: ['Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'],
    };
  }

  diagnostics.push(`Supabase URL configured: ${url}`);
  diagnostics.push(`Service Key present (${key.slice(0, 12)}...${key.slice(-6)})`);

  const startTime = Date.now();
  let reachable = false;
  let authenticated = false;
  let httpStatus: number | null = null;

  // Step 1: Check root PostgREST endpoint
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    httpStatus = res.status;
    reachable = true;
    diagnostics.push(`REST API connectivity probe: HTTP ${res.status}`);

    if (res.status === 200) {
      authenticated = true;
      diagnostics.push('Service Role Key successfully authenticated with Supabase PostgREST');
    } else if (res.status === 401 || res.status === 403) {
      diagnostics.push('Authentication failed: Invalid API key or insufficient permissions');
      return {
        configured: true,
        url,
        projectRef,
        dashboardSqlUrl,
        reachable: true,
        authenticated: false,
        httpStatus,
        latencyMs: Date.now() - startTime,
        tables,
        allTablesExist: false,
        readWriteVerified: false,
        message: `Connected to Supabase, but authorization failed (HTTP ${res.status}). Check SUPABASE_SERVICE_ROLE_KEY.`,
        diagnostics,
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push(`Network connection failed: ${msg}`);
    return {
      configured: true,
      url,
      projectRef,
      dashboardSqlUrl,
      reachable: false,
      authenticated: false,
      httpStatus: null,
      latencyMs: Date.now() - startTime,
      tables,
      allTablesExist: false,
      readWriteVerified: false,
      message: `Failed to reach Supabase at ${url}: ${msg}`,
      diagnostics,
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    return {
      configured: true,
      url,
      projectRef,
      dashboardSqlUrl,
      reachable,
      authenticated,
      httpStatus,
      latencyMs: Date.now() - startTime,
      tables,
      allTablesExist: false,
      readWriteVerified: false,
      message: 'Failed to initialize Supabase client.',
      diagnostics,
    };
  }

  // Step 2: Validate Schema Tables
  const tableNames = ['venues', 'artists', 'events', 'event_appearances'] as const;

  for (const tableName of tableNames) {
    try {
      const { error, status } = await client.from(tableName).select('id').limit(1);
      if (!error || status === 200 || status === 206) {
        tables[tableName] = true;
        diagnostics.push(`Table 'public.${tableName}': FOUND and accessible`);
      } else if (error.code === 'PGRST205' || status === 404) {
        tables[tableName] = false;
        diagnostics.push(`Table 'public.${tableName}': NOT FOUND (schema not applied yet)`);
      } else {
        // Table exists but returned other status/error (e.g. permission or empty)
        tables[tableName] = status !== 404 && error.code !== 'PGRST205';
        diagnostics.push(`Table 'public.${tableName}': Status ${status} (${error.message})`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      tables[tableName] = false;
      diagnostics.push(`Table 'public.${tableName}' probe failed: ${msg}`);
    }
  }

  const allTablesExist = tables.venues && tables.artists && tables.events && tables.event_appearances;
  let readWriteVerified = false;

  // Step 3: Test Read/Write if tables exist
  if (allTablesExist) {
    try {
      const testId = 'diag-test-' + Date.now();
      const { error: insertErr } = await client.from('venues').insert({
        id: testId,
        name: `Health Check Probe ${testId}`,
        city: 'Diagnostics City',
        state: 'CA',
        country: 'United States',
        is_outdoor: false,
      });

      if (!insertErr) {
        diagnostics.push('Write test: Successfully inserted probe venue record');
        const { data: readData, error: readErr } = await client
          .from('venues')
          .select('id')
          .eq('id', testId)
          .single();

        if (!readErr && readData?.id === testId) {
          diagnostics.push('Read test: Successfully queried probe venue record');
          readWriteVerified = true;
        }

        // Clean up probe record
        await client.from('venues').delete().eq('id', testId);
        diagnostics.push('Cleanup: Deleted probe venue record');
      } else {
        diagnostics.push(`Write probe returned error: ${insertErr.message}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`Read/Write verification probe failed: ${msg}`);
    }
  }

  const latencyMs = Date.now() - startTime;

  let message = '';
  if (allTablesExist && readWriteVerified) {
    message = 'Supabase persistent database is fully operational! Host is reachable, credentials verified, schema present, and read/write operations confirmed.';
  } else if (allTablesExist && !readWriteVerified) {
    message = 'Supabase database tables are present and queryable, but write test failed. Check RLS policies or permissions.';
  } else {
    message = 'Supabase instance is reachable and authenticated, but the required database tables have not been created yet. Run the SQL migration DDL in the Supabase SQL Editor.';
  }

  return {
    configured: true,
    url,
    projectRef,
    dashboardSqlUrl,
    reachable,
    authenticated,
    httpStatus,
    latencyMs,
    tables,
    allTablesExist,
    readWriteVerified,
    message,
    diagnostics,
  };
}

export async function syncEventsToSupabase(payload: {
  venues: any[];
  artists: any[];
  events: any[];
  appearances: any[];
}) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase client is not configured.');
  }

  // Maps to translate local IDs to authoritative Supabase IDs
  const venueIdMap = new Map<string, string>();
  const artistIdMap = new Map<string, string>();
  const eventIdMap = new Map<string, string>();

  // 1. Reconcile & Upsert Venues
  if (payload.venues && payload.venues.length > 0) {
    const { data: existingVenues, error: evErr } = await client.from('venues').select('id, name');
    if (evErr) throw new Error(`Failed to query existing venues: ${evErr.message}`);

    const existingNameMap = new Map<string, string>();
    (existingVenues || []).forEach((v) => {
      existingNameMap.set(v.name.trim().toLowerCase(), v.id);
      venueIdMap.set(v.id, v.id);
    });

    for (const v of payload.venues) {
      const normName = v.name.trim().toLowerCase();
      const existingId = existingNameMap.get(normName);

      if (existingId) {
        // Reuse existing Supabase ID
        venueIdMap.set(v.id, existingId);
        await client.from('venues').update({
          city: v.city,
          state: v.state || null,
          country: v.country,
          is_outdoor: v.isOutdoor ?? false,
          capacity: v.capacity || null,
        }).eq('id', existingId);
      } else {
        const targetId = v.id || ('ven-' + crypto.randomUUID().slice(0, 8));
        const { data: newV, error: insErr } = await client.from('venues').insert({
          id: targetId,
          name: v.name,
          city: v.city,
          state: v.state || null,
          country: v.country,
          is_outdoor: v.isOutdoor ?? false,
          capacity: v.capacity || null,
        }).select('id').single();

        if (insErr) {
          const { data: retryV } = await client.from('venues').select('id').ilike('name', v.name).single();
          if (retryV) {
            venueIdMap.set(v.id, retryV.id);
          } else {
            throw new Error(`Failed to insert venue "${v.name}": ${insErr.message}`);
          }
        } else if (newV) {
          venueIdMap.set(v.id, newV.id);
          existingNameMap.set(normName, newV.id);
        }
      }
    }
  }

  // 2. Reconcile & Upsert Artists
  if (payload.artists && payload.artists.length > 0) {
    const { data: existingArtists, error: eaErr } = await client.from('artists').select('id, name, musicbrainz_id');
    if (eaErr) throw new Error(`Failed to query existing artists: ${eaErr.message}`);

    const existingArtistNameMap = new Map<string, string>();
    (existingArtists || []).forEach((a) => {
      existingArtistNameMap.set(a.name.trim().toLowerCase(), a.id);
      artistIdMap.set(a.id, a.id);
    });

    for (const a of payload.artists) {
      const normName = a.name.trim().toLowerCase();
      const existingId = existingArtistNameMap.get(normName);

      if (existingId) {
        artistIdMap.set(a.id, existingId);
        const updatePayload: Record<string, any> = {};
        if (a.musicbrainz_id) updatePayload.musicbrainz_id = a.musicbrainz_id;
        if (a.disambiguation) updatePayload.disambiguation = a.disambiguation;
        if (a.genres && a.genres.length > 0) updatePayload.genres = a.genres;
        if (Object.keys(updatePayload).length > 0) {
          await client.from('artists').update(updatePayload).eq('id', existingId);
        }
      } else {
        const targetId = a.id || ('art-' + crypto.randomUUID().slice(0, 8));
        const { data: newA, error: insErr } = await client.from('artists').insert({
          id: targetId,
          name: a.name,
          musicbrainz_id: a.musicbrainz_id || null,
          disambiguation: a.disambiguation || null,
          genres: a.genres || [],
        }).select('id').single();

        if (insErr) {
          const { data: retryA } = await client.from('artists').select('id').ilike('name', a.name).single();
          if (retryA) {
            artistIdMap.set(a.id, retryA.id);
          } else {
            throw new Error(`Failed to insert artist "${a.name}": ${insErr.message}`);
          }
        } else if (newA) {
          artistIdMap.set(a.id, newA.id);
          existingArtistNameMap.set(normName, newA.id);
        }
      }
    }
  }

  // 3. Reconcile & Upsert Events
  if (payload.events && payload.events.length > 0) {
    const { data: existingEvents, error: eeErr } = await client.from('events').select('id, name, event_date');
    if (eeErr) throw new Error(`Failed to query existing events: ${eeErr.message}`);

    const existingEventKeyMap = new Map<string, string>();
    (existingEvents || []).forEach((e) => {
      existingEventKeyMap.set(`${e.name.trim().toLowerCase()}|${e.event_date}`, e.id);
      eventIdMap.set(e.id, e.id);
    });

    for (const e of payload.events) {
      const resolvedVenueId = venueIdMap.get(e.venue_id) || e.venue_id;
      const eventKey = `${e.name.trim().toLowerCase()}|${e.event_date}`;
      const existingId = existingEventKeyMap.get(eventKey) || (eventIdMap.has(e.id) ? e.id : undefined);

      const targetId = existingId || e.id || ('evt-' + crypto.randomUUID().slice(0, 8));
      eventIdMap.set(e.id, targetId);

      const eventRecord = {
        id: targetId,
        name: e.name,
        tour_name: e.tour_name || null,
        event_date: e.event_date,
        is_festival: e.is_festival ?? false,
        end_date: e.end_date || null,
        festival_days: e.festival_days || null,
        venue_id: resolvedVenueId,
        notes: e.notes || null,
        setlist_confirmed: e.setlist_confirmed ?? false,
        confidence_score: e.confidence_score,
        source_urls: e.source_urls || [],
        ticket_price: e.ticket_price || null,
        seating_tier: e.seating_tier || null,
        companions: e.companions || [],
        attendance_status: e.attendance_status || 'attended',
        rating: e.rating || 5,
      };

      const { error: upsertErr } = await client.from('events').upsert(eventRecord, { onConflict: 'id' });
      if (upsertErr) {
        throw new Error(`Failed to upsert event "${e.name}": ${upsertErr.message}`);
      }
    }
  }

  // 4. Reconcile & Upsert Appearances
  if (payload.appearances && payload.appearances.length > 0) {
    for (const app of payload.appearances) {
      const resolvedEventId = eventIdMap.get(app.event_id) || app.event_id;
      const resolvedArtistId = artistIdMap.get(app.artist_id) || app.artist_id;

      if (!resolvedEventId || !resolvedArtistId) continue;

      const appRecord = {
        event_id: resolvedEventId,
        artist_id: resolvedArtistId,
        billing_role: app.billing_role,
        billing_order: app.billing_order,
        stage_name: app.stage_name || null,
      };

      const { error: appErr } = await client.from('event_appearances').upsert(appRecord, {
        onConflict: 'event_id,artist_id',
      });
      if (appErr) {
        console.warn(`Warning: Could not upsert appearance: ${appErr.message}`);
      }
    }
  }

  return {
    success: true,
    syncedCounts: {
      venues: payload.venues?.length || 0,
      artists: payload.artists?.length || 0,
      events: payload.events?.length || 0,
      appearances: payload.appearances?.length || 0,
    },
  };
}

export async function fetchEventsFromSupabase() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase client is not configured.');
  }

  const { data: events, error: eErr } = await client
    .from('events')
    .select(`
      *,
      venue:venues(*),
      appearances:event_appearances(
        *,
        artist:artists(*)
      )
    `)
    .order('event_date', { ascending: false });

  if (eErr) {
    throw new Error(`Failed to fetch events: ${eErr.message}`);
  }

  return (events || []).map((e: any) => ({
    ...e,
    venue: e.venue || {
      id: e.venue_id,
      name: 'Unknown Venue',
      city: 'Unknown City',
      country: 'Unknown Country',
    },
    appearances: (e.appearances || []).map((app: any) => ({
      ...app,
      artist: app.artist || {
        id: app.artist_id,
        name: 'Unknown Artist',
      },
    })),
  }));
}
