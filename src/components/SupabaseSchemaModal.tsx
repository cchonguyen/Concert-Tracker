import React, { useState, useEffect } from 'react';
import {
  Database,
  Copy,
  Check,
  Code2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  Zap,
  Activity,
  UploadCloud,
  DownloadCloud,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { generateSupabaseSqlSchema } from '../services/export';
import lineupMigrationSql from '../../supabase/migrations/0002_source_first_lineups.sql?raw';
import {
  checkSupabaseStatus,
  validateSupabaseConnection,
  syncToSupabase,
  fetchSupabaseArchive,
  SupabaseClientValidation,
} from '../services/api';
import { concertStore } from '../services/storage';

export const SupabaseSchemaModal: React.FC = () => {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [validation, setValidation] = useState<SupabaseClientValidation | null>(null);

  const sql = `${generateSupabaseSqlSchema()}\n\n${lineupMigrationSql}`;

  const runValidation = async () => {
    setLoading(true);
    setSyncResult(null);
    try {
      const res = await validateSupabaseConnection();
      setValidation(res);
    } catch {
      // Handled in api.ts
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runValidation();
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handlePullFromSupabase = async () => {
    if (!validation?.allTablesExist) return;
    setPulling(true);
    setSyncResult(null);
    try {
      const res = await fetchSupabaseArchive();
      if (res.success && res.events) {
        const imported = concertStore.importFromSupabase(res.events);
        setSyncResult(
          `Successfully pulled ${res.events.length} events from Supabase (${imported} new records added to local archive)!`,
        );
      } else {
        setSyncResult(`Pull failed: ${res.error || 'Failed to fetch events from Supabase'}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Pull error';
      setSyncResult(`Pull error: ${msg}`);
    } finally {
      setPulling(false);
    }
  };

  const handleSyncToSupabase = async () => {
    if (!validation?.allTablesExist) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const venues = concertStore.getAllVenues();
      const artists = concertStore.getAllArtists();
      const populatedEvents = concertStore.getAllEvents();

      // Extract raw events and appearances
      const events = populatedEvents.map((e) => ({
        id: e.id,
        name: e.name,
        tour_name: e.tour_name,
        event_date: e.event_date,
        is_festival: e.is_festival,
        end_date: e.end_date,
        festival_days: e.festival_days,
        venue_id: e.venue_id,
        notes: e.notes,
        setlist_confirmed: e.setlist_confirmed,
        confidence_score: e.confidence_score,
        source_urls: e.source_urls,
        ticket_price: e.ticket_price,
        seating_tier: e.seating_tier,
        companions: e.companions,
        attendance_status: e.attendance_status,
        rating: e.rating,
      }));

      const appearances = populatedEvents.flatMap((e) =>
        e.appearances.map((app) => ({
          id: app.id,
          event_id: e.id,
          artist_id: app.artist_id,
          billing_role: app.billing_role,
          billing_order: app.billing_order,
          stage_name: app.stage_name,
        })),
      );

      const res = await syncToSupabase({
        venues,
        artists,
        events,
        appearances,
      });

      if (res.success) {
        setSyncResult(
          `Successfully synced ${res.syncedCounts?.events || events.length} events, ${res.syncedCounts?.venues || venues.length} venues, and ${res.syncedCounts?.artists || artists.length} artists to Supabase!`,
        );
      } else {
        setSyncResult(`Sync failed: ${res.message || 'Unknown error'}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sync error';
      setSyncResult(`Sync error: ${msg}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6 py-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-950/40 px-3 py-1 text-xs font-medium text-violet-300">
            <Database className="h-3.5 w-3.5 text-violet-400" />
            <span>Supabase Persistent Relational Core</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Supabase Database Validation & Relational Topology
          </h2>
          <p className="text-xs text-zinc-400">
            Live health verification, connection diagnostics, and authoritative PostgreSQL schema migration.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runValidation}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            title="Re-run live health check"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-violet-400' : ''}`} />
            <span>{loading ? 'Validating...' : 'Validate Database'}</span>
          </button>

          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-lg hover:bg-violet-500 transition-colors"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span>{copied ? 'Copied Migration DDL!' : 'Copy SQL Migration'}</span>
          </button>
        </div>
      </div>

      {/* Live Validation Diagnostics Card */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-xl backdrop-blur-sm space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-zinc-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                validation?.allTablesExist && validation?.readWriteVerified
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30'
                  : validation?.reachable && validation?.authenticated
                    ? 'bg-amber-950 text-amber-400 border border-amber-500/30'
                    : 'bg-rose-950 text-rose-400 border border-rose-500/30'
              }`}
            >
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">Live Supabase Database Status</h3>
                {validation?.reachable && validation?.authenticated && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Online ({validation.latencyMs}ms)
                  </span>
                )}
              </div>
              <p className="font-mono text-xs text-zinc-400">
                {validation?.url || 'No SUPABASE_URL configured'}
              </p>
            </div>
          </div>

          {/* Action links */}
          <div className="flex items-center gap-2">
            {validation?.dashboardSqlUrl && (
              <a
                href={validation.dashboardSqlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-950/40 px-3 py-1.5 text-xs font-semibold text-violet-300 hover:bg-violet-900/50 transition-colors"
              >
                <span>Open Supabase SQL Editor</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            )}

            {validation?.allTablesExist && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePullFromSupabase}
                  disabled={pulling || syncing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-950/40 px-3.5 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/50 transition-colors disabled:opacity-50"
                  title="Import events and performers from Supabase into your local archive"
                >
                  <DownloadCloud className="h-3.5 w-3.5" />
                  <span>{pulling ? 'Pulling...' : 'Pull from Supabase'}</span>
                </button>

                <button
                  onClick={handleSyncToSupabase}
                  disabled={syncing || pulling}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
                  title="Push and reconcile local archive records into Supabase"
                >
                  <UploadCloud className="h-3.5 w-3.5" />
                  <span>{syncing ? 'Syncing...' : 'Sync Archive to Supabase'}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Sync notification message */}
        {syncResult && (
          <div
            className={`rounded-xl p-3 text-xs flex items-center gap-2 ${
              syncResult.includes('Successfully')
                ? 'bg-emerald-950/60 border border-emerald-500/30 text-emerald-300'
                : 'bg-rose-950/60 border border-rose-500/30 text-rose-300'
            }`}
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{syncResult}</span>
          </div>
        )}

        {/* Health Summary Banner */}
        <div
          className={`rounded-xl border p-4 text-xs ${
            validation?.allTablesExist && validation?.readWriteVerified
              ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
              : validation?.reachable && validation?.authenticated
                ? 'border-amber-500/30 bg-amber-950/20 text-amber-300'
                : 'border-rose-500/30 bg-rose-950/20 text-rose-300'
          }`}
        >
          <div className="flex items-start gap-3">
            {validation?.allTablesExist && validation?.readWriteVerified ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <div className="font-semibold text-sm">
                {validation?.allTablesExist && validation?.readWriteVerified
                  ? 'Supabase Database Verified & Active'
                  : validation?.reachable && validation?.authenticated
                    ? 'Connection Authenticated — Schema Setup Required'
                    : 'Supabase Database Disconnected'}
              </div>
              <p className="text-zinc-300 leading-relaxed">
                {validation?.message || 'Inspecting database status...'}
              </p>
              {validation?.reachable && !validation.allTablesExist && (
                <div className="mt-2 text-zinc-300">
                  <span className="font-semibold text-amber-200">How to activate in 10 seconds:</span>{' '}
                  1. Click <strong className="text-white">"Copy SQL Migration"</strong> above. 2. Click{' '}
                  <strong className="text-white">"Open Supabase SQL Editor"</strong>. 3. Paste the SQL and click <strong className="text-white">Run</strong>. 4. Click <strong className="text-white">"Validate Database"</strong>!
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1">
            <span className="text-zinc-500 font-medium text-[11px]">API Connectivity</span>
            <div className="flex items-center gap-1.5 font-semibold text-white">
              {validation?.reachable ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Reachable (HTTP {validation.httpStatus})</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
                  <span>Unreachable</span>
                </>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1">
            <span className="text-zinc-500 font-medium text-[11px]">Credentials Check</span>
            <div className="flex items-center gap-1.5 font-semibold text-white">
              {validation?.authenticated ? (
                <>
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Service Key Valid</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
                  <span>Auth Failed</span>
                </>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1">
            <span className="text-zinc-500 font-medium text-[11px]">Relational Tables</span>
            <div className="flex items-center gap-1.5 font-semibold text-white">
              {validation?.allTablesExist ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  <span>All 4 Tables Exist</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  <span>
                    {Object.values(validation?.tables || {}).filter(Boolean).length}/4 Created
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1">
            <span className="text-zinc-500 font-medium text-[11px]">Persistence Probed</span>
            <div className="flex items-center gap-1.5 font-semibold text-white">
              {validation?.readWriteVerified ? (
                <>
                  <Zap className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Read/Write Confirmed</span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-zinc-600" />
                  <span className="text-zinc-400">Pending Schema</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Expandable Diagnostic Trace */}
        <div className="border-t border-zinc-800/80 pt-3">
          <button
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span>{showDiagnostics ? 'Hide Diagnostic Probes' : 'View Full Validation Diagnostic Trace'}</span>
            {showDiagnostics ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          {showDiagnostics && validation && (
            <div className="mt-3 rounded-xl bg-zinc-950 p-3 font-mono text-[11px] text-zinc-300 space-y-1 border border-zinc-800">
              <div className="text-zinc-500 pb-1 border-b border-zinc-900 font-sans text-xs font-semibold">
                Live Validation Probe Log:
              </div>
              {validation.diagnostics.map((diag, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-zinc-600 select-none">[{i + 1}]</span>
                  <span
                    className={
                      diag.includes('FOUND') || diag.includes('successfully') || diag.includes('HTTP 200')
                        ? 'text-emerald-400'
                        : diag.includes('NOT FOUND')
                          ? 'text-amber-400'
                          : diag.includes('failed')
                            ? 'text-rose-400'
                            : 'text-zinc-300'
                    }
                  >
                    {diag}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Relational Entity Breakdown */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* public.venues */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-indigo-300">public.venues</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                validation?.tables.venues
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {validation?.tables.venues ? 'Verified' : 'Pending'}
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Physical infrastructure: venue name, city, state, country, outdoor staging, and capacity.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">PK: id (text) · Unique(name)</div>
        </div>

        {/* public.artists */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-cyan-300">public.artists</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                validation?.tables.artists
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {validation?.tables.artists ? 'Verified' : 'Pending'}
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Performer registry holding canonical MusicBrainz Identifiers (MBIDs) and genres.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">PK: id (text) · MBID</div>
        </div>

        {/* public.events */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-violet-300">public.events</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                validation?.tables.events
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {validation?.tables.events ? 'Verified' : 'Pending'}
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Authoritative transactional core storing dates, tours, notes, setlist confirmation, and tickets.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">PK: id (text) · FK: venue_id</div>
        </div>

        {/* public.event_appearances */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-emerald-300">public.event_appearances</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                validation?.tables.event_appearances
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {validation?.tables.event_appearances ? 'Verified' : 'Pending'}
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Decomposed lineup hierarchy: billing role (headliner, support), order, and stage assignment.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">FK: event_id, artist_id</div>
        </div>
      </div>

      {/* Code DDL Box */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-4 py-2.5 text-xs text-zinc-400">
          <div className="flex items-center gap-2 font-mono">
            <Code2 className="h-4 w-4 text-violet-400" />
            <span>schema_migration_v1.sql</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-zinc-500">PostgreSQL / Supabase Ready</span>
            <button
              onClick={handleCopy}
              className="text-xs font-semibold text-violet-400 hover:text-violet-300 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy Code'}
            </button>
          </div>
        </div>

        <div className="max-h-[480px] overflow-y-auto p-4 font-mono text-xs text-zinc-300 leading-relaxed">
          <pre>{sql}</pre>
        </div>
      </div>
    </div>
  );
};
