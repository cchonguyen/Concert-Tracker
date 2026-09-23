import React, { useState } from 'react';
import {
  FileSpreadsheet,
  Download,
  Send,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Code,
  FileCode,
  Clock,
  Radio,
} from 'lucide-react';
import { PopulatedEvent } from '../types/schema';
import {
  downloadFile,
  serializeEventsToCsv,
  serializeEventsToJson,
} from '../services/export';
import { dispatchSheetsSync } from '../services/api';

interface SheetsSyncModalProps {
  events: PopulatedEvent[];
  selectedEventForSync?: PopulatedEvent | null;
}

export const SheetsSyncModal: React.FC<SheetsSyncModalProps> = ({
  events,
  selectedEventForSync,
}) => {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    success: boolean;
    message: string;
    payload?: any;
  } | null>(null);

  const [activeTab, setActiveTab] = useState<'webhook' | 'csv_preview' | 'json_preview'>('webhook');

  const csvContent = serializeEventsToCsv(events);
  const jsonContent = serializeEventsToJson(events);

  const handleDownloadCsv = () => {
    downloadFile(
      `livearchive_concerts_${new Date().toISOString().slice(0, 10)}.csv`,
      csvContent,
      'text/csv;charset=utf-8;',
    );
  };

  const handleDownloadJson = () => {
    downloadFile(
      `livearchive_manifests_${new Date().toISOString().slice(0, 10)}.json`,
      jsonContent,
      'application/json;charset=utf-8;',
    );
  };

  const handleTestDispatch = async () => {
    if (events.length === 0) return;
    setIsSyncing(true);
    setSyncResult(null);

    const targetEvent = selectedEventForSync || events[0];
    const res = await dispatchSheetsSync(targetEvent, webhookUrl);

    setSyncResult(res);
    setIsSyncing(false);
  };

  return (
    <div className="space-y-8 py-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="space-y-1">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-950/40 px-3 py-1 text-xs font-medium text-emerald-300">
          <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
          <span>Downstream Synchronization & Portability</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Google Sheets Downstream Replica & Data Portability
        </h2>
        <p className="text-xs text-zinc-400">
          Unidirectional read replica governance: Supabase remains the authoritative core while Google Sheets receives automated webhook updates.
        </p>
      </div>

      {/* Portability Quick Download Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* CSV Tabular Card */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="rounded-xl bg-emerald-950 p-2 text-emerald-400 border border-emerald-500/30">
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">CSV Tabular Export</h3>
                <p className="text-xs text-zinc-400">Single-row per event with semicolon-delimited artists</p>
              </div>
            </div>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Format: <code className="text-violet-300">Porter Robinson; Ericdoa</code>. Ready for direct Google Sheets import, Microsoft Excel, or downstream reporting pipelines.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleDownloadCsv}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-md hover:bg-emerald-500 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download Full CSV ({events.length} rows)</span>
            </button>
            <button
              onClick={() => setActiveTab('csv_preview')}
              className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:text-white transition-colors"
            >
              Preview CSV
            </button>
          </div>
        </div>

        {/* JSON Nested Document Card */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="rounded-xl bg-violet-950 p-2 text-violet-400 border border-violet-500/30">
                <FileCode className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">JSON Nested Collection</h3>
                <p className="text-xs text-zinc-400">Complete arrays of artist objects, venues & timestamps</p>
              </div>
            </div>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Preserves full relational fidelity, MusicBrainz MBIDs, billing stages, setlist tracks, and confidence metadata in JSON format.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleDownloadJson}
              className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-md hover:bg-violet-500 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download JSON Manifest</span>
            </button>
            <button
              onClick={() => setActiveTab('json_preview')}
              className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:text-white transition-colors"
            >
              Preview JSON
            </button>
          </div>
        </div>
      </div>

      {/* Webhook Dispatch & Edge Function Simulator */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl space-y-5">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-bold text-white">
              Supabase Database Webhook & Edge Function Dispatcher
            </h3>
          </div>
          <span className="text-xs text-zinc-400">Target: Google Sheets REST API</span>
        </div>

        <div className="space-y-3">
          <label className="block text-xs font-medium text-zinc-300">
            Google Sheets Webhook URL (Google Apps Script Web App or Zapier/Make Edge Webhook)
          </label>
          <div className="flex flex-col sm:flex-row items-center gap-2">
            <input
              type="url"
              placeholder="https://script.google.com/macros/s/.../exec (Leave empty to test simulated Edge Function payload)"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="w-full flex-1 rounded-xl border border-zinc-700 bg-zinc-950 px-3.5 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <button
              onClick={handleTestDispatch}
              disabled={isSyncing || events.length === 0}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-2 text-xs font-semibold text-white shadow-md hover:opacity-95 disabled:opacity-50 transition-all"
            >
              {isSyncing ? (
                <>
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Dispatching...</span>
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  <span>Dispatch Downstream Sync</span>
                </>
              )}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">
            When triggered, Supabase executes <code className="text-emerald-300">net.http_post</code> appending the new event row to the spreadsheet.
          </p>
        </div>

        {/* Sync Result Feedback */}
        {syncResult && (
          <div
            className={`rounded-xl border p-4 text-xs space-y-2 ${
              syncResult.success
                ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                : 'border-red-500/40 bg-red-950/30 text-red-300'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {syncResult.success ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-400" />
              )}
              <span>{syncResult.message}</span>
            </div>

            {syncResult.payload && (
              <div className="rounded-lg bg-zinc-950 p-3 font-mono text-[11px] text-zinc-300 overflow-x-auto">
                <span className="text-zinc-500">// Dispatched Row Payload:</span>
                <pre>{JSON.stringify(syncResult.payload, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Previews if activated */}
      {activeTab === 'csv_preview' && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-zinc-800 pb-2">
            <span className="font-semibold text-white">Serialized CSV Content Preview</span>
            <button
              onClick={() => setActiveTab('webhook')}
              className="text-zinc-500 hover:text-white"
            >
              Close Preview
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto font-mono text-xs text-zinc-300 whitespace-pre">
            {csvContent}
          </div>
        </div>
      )}

      {activeTab === 'json_preview' && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-zinc-800 pb-2">
            <span className="font-semibold text-white">Serialized JSON Manifest Preview</span>
            <button
              onClick={() => setActiveTab('webhook')}
              className="text-zinc-500 hover:text-white"
            >
              Close Preview
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto font-mono text-xs text-zinc-300 whitespace-pre">
            {jsonContent}
          </div>
        </div>
      )}
    </div>
  );
};
