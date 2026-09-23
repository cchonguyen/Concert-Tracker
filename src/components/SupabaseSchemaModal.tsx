import React, { useState } from 'react';
import {
  Database,
  Copy,
  Check,
  Code2,
  TableProperties,
  ArrowRight,
  ShieldCheck,
  ExternalLink,
} from 'lucide-react';
import { generateSupabaseSqlSchema } from '../services/export';

export const SupabaseSchemaModal: React.FC = () => {
  const [copied, setCopied] = useState(false);
  const sql = generateSupabaseSqlSchema();

  const handleCopy = () => {
    navigator.clipboard.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6 py-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-950/40 px-3 py-1 text-xs font-medium text-violet-300">
            <Database className="h-3.5 w-3.5 text-violet-400" />
            <span>Authoritative Relational Core</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Supabase Relational Topology & SQL DDL
          </h2>
          <p className="text-xs text-zinc-400">
            Strict relational schema normalizing events, venues, canonical artists (with MBIDs), and billing hierarchies.
          </p>
        </div>

        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-lg hover:bg-violet-500 transition-colors"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span>{copied ? 'Copied Migration DDL!' : 'Copy SQL Migration'}</span>
        </button>
      </div>

      {/* Relational Entity Breakdown */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-violet-300">public.events</span>
            <span className="rounded bg-violet-950 px-1.5 py-0.5 text-[10px] text-violet-400">
              Core
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Authoritative transactional core storing dates, tours, notes, setlist confirmation, confidence scores, and ticket ledger.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">
            PK: id · FK: venue_id
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-indigo-300">public.venues</span>
            <span className="rounded bg-indigo-950 px-1.5 py-0.5 text-[10px] text-indigo-400">
              Lookup
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Normalized physical infrastructure with municipality, administrative division, country, and open-air staging flag.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">
            PK: id · Unique(name)
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-cyan-300">public.artists</span>
            <span className="rounded bg-cyan-950 px-1.5 py-0.5 text-[10px] text-cyan-400">
              Registry
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Performer registry holding canonical MusicBrainz Identifiers (MBIDs) to eliminate naming ambiguities.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">
            PK: id · Unique(name) · MBID
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-emerald-300">
              public.event_appearances
            </span>
            <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-400">
              Junction
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Decomposed lineup hierarchy with billing role (headliner, support, guest, festival) and stage assignment.
          </p>
          <div className="font-mono text-[10px] text-zinc-500">
            FK: event_id, artist_id
          </div>
        </div>
      </div>

      {/* Code DDL Box */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-4 py-2.5 text-xs text-zinc-400">
          <div className="flex items-center gap-2 font-mono">
            <Code2 className="h-4 w-4 text-violet-400" />
            <span>schema_migration_v1.sql</span>
          </div>
          <span className="text-[11px] text-zinc-500">PostgreSQL / Supabase Ready</span>
        </div>

        <div className="max-h-[500px] overflow-y-auto p-4 font-mono text-xs text-zinc-300 leading-relaxed">
          <pre>{sql}</pre>
        </div>
      </div>
    </div>
  );
};
