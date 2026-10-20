import React from 'react';
import {
  Calendar,
  Database,
  FileSpreadsheet,
  Layers,
  Music,
  Radio,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

export type NavTab = 'staging' | 'archive' | 'analytics' | 'supabase' | 'sheets';

interface NavbarProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  eventCount: number;
  artistCount: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  eventCount,
  artistCount,
}) => {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        {/* Brand identity */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-violet-600 via-indigo-600 to-cyan-400 text-white shadow-lg shadow-violet-500/20">
            <Radio className="h-5 w-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-extrabold tracking-tight text-white sm:text-lg">
                Live<span className="text-violet-400">Archive</span>
              </span>
              <span className="rounded-md border border-violet-500/30 bg-violet-950/60 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-violet-300 uppercase">
                Source-first
              </span>
            </div>
            <p className="hidden text-xs text-zinc-400 sm:block">
              Cited lineups · Supabase core · Sheets downstream
            </p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/90 p-1">
          <button
            onClick={() => setActiveTab('staging')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all sm:text-sm ${
              activeTab === 'staging'
                ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-600/30'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Add event</span>
          </button>

          <button
            onClick={() => setActiveTab('archive')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all sm:text-sm ${
              activeTab === 'archive'
                ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-600/30'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            <Calendar className="h-3.5 w-3.5" />
            <span>Archive</span>
            <span className="ml-1 rounded-full bg-zinc-800 px-1.5 py-0.2 text-[10px] font-semibold text-zinc-300">
              {eventCount}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('analytics')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all sm:text-sm ${
              activeTab === 'analytics'
                ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-600/30'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            <TrendingUp className="h-3.5 w-3.5" />
            <span>Telemetry</span>
          </button>

          <button
            onClick={() => setActiveTab('supabase')}
            className={`hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all sm:flex sm:text-sm ${
              activeTab === 'supabase'
                ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-600/30'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            <Database className="h-3.5 w-3.5" />
            <span>Supabase DB</span>
          </button>

          <button
            onClick={() => setActiveTab('sheets')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all sm:text-sm ${
              activeTab === 'sheets'
                ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-600/30'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sheets Sync & Export</span>
            <span className="sm:hidden">Sync</span>
          </button>
        </nav>
      </div>
    </header>
  );
};
